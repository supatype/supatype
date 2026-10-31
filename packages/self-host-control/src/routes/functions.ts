import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { isFunctionDeployBody, isRecordOf, isShape, isString, optional } from "@supatype/shared"
import { badRequest, bodyOf, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { functionFiles, writeChanged, type DeployFile } from "../deploy-files.js"
import { answerWithWorkerCurrent, childDir, functionEnvPath, functionsRoot } from "../worker.js"

/** The directory of the function `name`, refused unless it may be one (worker.ts `childDir`). */
function functionDir(name: unknown): string {
  return childDir(functionsRoot(), name, "function")
}

/**
 * The files a deploy body's functions write, every function and path checked before anything is
 * written (deploy-files.ts). Its count of functions comes with them.
 */
function deployedFiles(body: unknown): { count: number; files: DeployFile[] } {
  const { functions } = bodyOf(body, isFunctionDeployBody)
  const files = functions.flatMap((fn) => functionFiles({ name: fn.name, dir: functionDir(fn.name), source: fn.source, files: fn.files }))
  return { count: functions.length, files }
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
    const { count, files } = deployedFiles(ctx.body)
    await writeChanged(files)
    await answerWithWorkerCurrent(ctx.res, { message: "Functions deployed", count })
  })

  route(routes, "DELETE", "/projects/:ref/functions/:name", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const name = ctx.params["name"]!
    rmSync(functionDir(name), { recursive: true, force: true })
    await answerWithWorkerCurrent(ctx.res, { deleted: name })
  })

  // The names only, sorted, as Cloud lists them: a value is a secret, and never leaves the stack.
  route(routes, "GET", "/projects/:ref/functions/env", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, { data: Object.keys(readFunctionEnv()).sort() })
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
    await answerWithWorkerCurrent(ctx.res, { key: body.key })
  })

  // `supatype functions env unset` on a self-host link. An env change restarts nothing, since the worker reads the file on each call (worker.ts); the
  // worker is still started if it stopped, or restarted for a restart a failed deploy owes.
  route(routes, "DELETE", "/projects/:ref/functions/env/:key", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const key = decodedParam(ctx.params["key"]!)
    const current = readFunctionEnv()
    const removed = Object.hasOwn(current, key)
    if (removed) {
      delete current[key]
      writeFunctionEnv(current)
    }
    await answerWithWorkerCurrent(ctx.res, { key, removed })
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
