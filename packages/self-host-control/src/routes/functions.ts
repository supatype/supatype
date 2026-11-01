import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  FUNCTION_ENTRY_FILE,
  FUNCTION_NAME_RULE,
  functionRouteName,
  isFunctionDeployBody,
  isFunctionName,
  isRecordOf,
  isShape,
  isString,
  optional,
  SERVICE_ROLE_ROUTES_FILE,
} from "@supatype/shared"
import { badRequest, bodyOf, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { functionFiles, removeAll, writeChanged, writeFileIn, writeRoot, type FunctionWrite } from "../deploy-files.js"
import { answerWithWorkerCurrent, childDir, functionEnvPath, functionsRoot } from "../worker.js"

/**
 * The functions under `root` the worker serves, sorted: found by the rule it discovers its routes by
 * (`functionRouteName`, @supatype/shared), so `_shared`, dot directories, a directory with no
 * index.ts and a declaration file are not listed, and a function kept as `<name>.ts` is.
 */
function servedFunctions(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : undefined
      const name = kind === undefined ? undefined : functionRouteName(entry.name, kind)
      if (name === undefined) return undefined
      return kind === "file" || existsSync(join(root, entry.name, FUNCTION_ENTRY_FILE)) ? name : undefined
    })
    .filter((name): name is string => name !== undefined)
    .sort()
}

/** The directory of the function `name`, refused unless it may be one (worker.ts `childDir`). */
function functionDir(name: unknown): string {
  return childDir(functionsRoot(), name, "function")
}

/**
 * What a deploy body's functions write and remove, every function and path checked before anything
 * is written (deploy-files.ts). Its count of functions comes with them.
 */
function deployedFiles(body: unknown): { count: number; writes: FunctionWrite[]; serviceRole: string[] | undefined } {
  const { functions, serviceRole } = bodyOf(body, isFunctionDeployBody)
  const refused = (serviceRole ?? []).filter((name) => !isFunctionName(name))
  if (refused.length > 0) throw badRequest(`serviceRole names ${refused.map((name) => JSON.stringify(name)).join(", ")}, which are not function names: ${FUNCTION_NAME_RULE}`)
  const root = writeRoot(functionsRoot(), "Functions", { mayBeLink: true })
  const writes = functions.map((fn) => {
    functionDir(fn.name)
    return functionFiles(root, { name: fn.name, source: fn.source, files: fn.files })
  })
  return { count: functions.length, writes, serviceRole }
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
    sendJson(ctx.res, 200, { data: servedFunctions(functionsRoot()).map((name) => ({ name })) })
  })

  route(routes, "POST", "/projects/:ref/functions/deploy", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const { count, writes, serviceRole } = deployedFiles(ctx.body)
    // Written before the other form is removed, so the function is never missing in between.
    await writeChanged(writes.flatMap((write) => write.files))
    await removeAll(writes.flatMap((write) => write.remove))
    // The list replaces the last wholesale, as on Cloud; the worker reads it on every call, so a
    // route taken off it loses the key on its next call. A deploy that sends none leaves it alone.
    if (serviceRole !== undefined) await writeFileIn(dirname(functionEnvPath()), SERVICE_ROLE_ROUTES_FILE, serviceRole.join(","))
    await answerWithWorkerCurrent(ctx.res, { message: "Functions deployed", count })
  })

  route(routes, "DELETE", "/projects/:ref/functions/:name", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const name = ctx.params["name"]!
    // Whichever form the project keeps it in, both when both are there.
    const dir = functionDir(name)
    await removeAll([dir, `${dir}.ts`])
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
    await writeFunctionEnv(current)
    await answerWithWorkerCurrent(ctx.res, { key: body.key }, { codeUnchanged: true })
  })

  // `supatype functions env unset` on a self-host link. An env change restarts nothing, since the
  // worker reads the file on each call (worker.ts); the worker is still started if it stopped, or
  // restarted for a restart a failed deploy owes.
  route(routes, "DELETE", "/projects/:ref/functions/env/:key", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const key = decodedParam(ctx.params["key"]!)
    const current = readFunctionEnv()
    const removed = Object.hasOwn(current, key)
    if (removed) {
      delete current[key]
      await writeFunctionEnv(current)
    }
    await answerWithWorkerCurrent(ctx.res, { key, removed }, { codeUnchanged: true })
  })
}

/** Writes the function env file, a link there refused rather than followed (deploy-files.ts). */
async function writeFunctionEnv(env: Record<string, string>): Promise<void> {
  await writeFileIn(dirname(functionEnvPath()), basename(functionEnvPath()), `${JSON.stringify(env, null, 2)}\n`)
}

/** A path parameter as the caller encoded it (encodeURIComponent); a 400 when it cannot be decoded. */
function decodedParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw badRequest(`${JSON.stringify(raw)} is not a valid URL-encoded name`)
  }
}
