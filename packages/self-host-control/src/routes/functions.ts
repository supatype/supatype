import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { isJsonObject, isRecordOf, isShape, isString, isUnknown, optional } from "@supatype/shared"
import { badRequest, bodyOf, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { childDir, ensureWorkerCurrent, functionEnvPath, functionsRoot } from "../worker.js"

interface DeployedFunction {
  name: string
  source: string
}


/** The directory of the function `name`, refused unless it may be one (worker.ts `childDir`). */
function functionDir(name: unknown): string {
  return childDir(functionsRoot(), name, "function")
}

/** The functions a deploy body names, every one checked before anything is written. */
function deployedFunctions(body: unknown): Array<DeployedFunction & { dir: string }> {
  const list = bodyOf(body, isShape({ functions: optional(isUnknown) })).functions
  if (list === undefined) return []
  if (!Array.isArray(list)) throw badRequest("functions must be an array")
  return list.map((entry) => {
    const fn = isJsonObject(entry) ? entry : {}
    const dir = functionDir(fn["name"])
    const name = String(fn["name"])
    const source = fn["source"]
    if (typeof source !== "string") throw badRequest(`Function ${name} has no source`)
    return { name, source, dir }
  })
}


const isFunctionEnv = isRecordOf(isString)

/** The env file `POST /functions/env` writes: refused, rather than overwritten, when it is not one. */
function readFunctionEnv(): Record<string, string> {
  if (!existsSync(functionEnvPath())) return {}
  const env = JSON.parse(readFileSync(functionEnvPath(), "utf8"))
  if (!isFunctionEnv(env)) throw new Error(`${functionEnvPath()} is not a map of names to string values`)
  return env
}

const isEnvBody = isShape({ key: optional(isString), value: optional(isString) })

export function registerFunctionRoutes(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "GET", "/projects/:ref/functions", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const root = functionsRoot()
    if (!existsSync(root)) {
      sendJson(ctx.res, 200, { data: [] })
      return
    }
    const names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name }))
    sendJson(ctx.res, 200, { data: names })
  })

  route(routes, "POST", "/projects/:ref/functions/deploy", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const functions = deployedFunctions(ctx.body)
    for (const fn of functions) {
      mkdirSync(fn.dir, { recursive: true })
      writeFileSync(join(fn.dir, "index.ts"), fn.source, "utf8")
    }

    await ensureWorkerCurrent()
    sendJson(ctx.res, 200, { data: { message: "Functions deployed", count: functions.length } })
  })

  route(routes, "DELETE", "/projects/:ref/functions/:name", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const name = ctx.params["name"]!
    rmSync(functionDir(name), { recursive: true, force: true })
    await ensureWorkerCurrent()
    sendJson(ctx.res, 200, { data: { deleted: name } })
  })

  route(routes, "GET", "/projects/:ref/functions/env", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, { data: readFunctionEnv() })
  })

  route(routes, "POST", "/projects/:ref/functions/env", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = bodyOf(ctx.body, isEnvBody)
    if (!body.key) {
      sendJson(ctx.res, 400, { error: "validation_error", message: "key required" })
      return
    }
    const current = readFunctionEnv()
    current[body.key] = body.value ?? ""
    writeFunctionEnv(current)
    await ensureWorkerCurrent()
    sendJson(ctx.res, 200, { data: { key: body.key } })
  })

  // `supatype functions env unset` on a self-host link: refused until now, since there was no route.
  // A key not set changes nothing, so the worker is restarted for it only when it is stale anyway.
  route(routes, "DELETE", "/projects/:ref/functions/env/:key", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const key = decodedParam(ctx.params["key"]!)
    const current = readFunctionEnv()
    const removed = Object.hasOwn(current, key)
    if (removed) {
      delete current[key]
      writeFunctionEnv(current)
    }
    await ensureWorkerCurrent()
    sendJson(ctx.res, 200, { data: { key, removed } })
  })
}

/** Writes the function env file. */
function writeFunctionEnv(env: Record<string, string>): void {
  mkdirSync(dirname(functionEnvPath()), { recursive: true })
  writeFileSync(functionEnvPath(), `${JSON.stringify(env, null, 2)}\n`, "utf8")
}

/** A path parameter as the caller encoded it (encodeURIComponent); a 400 when it cannot be decoded. */
function decodedParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw badRequest(`${JSON.stringify(raw)} is not a valid URL-encoded name`)
  }
}
