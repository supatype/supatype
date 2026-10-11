import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { badRequest, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject, projectRoot } from "../project.js"

/**
 * A function name: lowercase letters, digits, `-` and `_`, starting with a letter or digit. The CLI
 * has no rule of its own (it sends whatever directory names it finds), so this is the strict one:
 * nothing in it can name a parent, a separator or a hidden entry.
 */
const FUNCTION_NAME = /^[a-z0-9][a-z0-9_-]*$/

interface DeployedFunction {
  name: string
  source: string
}

function functionsRoot(): string {
  return process.env["SUPATYPE_FUNCTIONS_ROOT"] ?? join(projectRoot(), "functions")
}

function composeProject(): string {
  return process.env["COMPOSE_PROJECT_NAME"] ?? "supatype-project"
}

function restartFunctionsWorker(): void {
  spawnSync(
    "docker",
    ["compose", "-p", composeProject(), "restart", "functions-worker"],
    { stdio: "inherit" },
  )
}

/** `name` when it passes the function-name rule; a 400 otherwise. */
function checkedName(name: unknown): string {
  if (typeof name !== "string" || !FUNCTION_NAME.test(name)) {
    throw badRequest(
      `Invalid function name ${JSON.stringify(name)}: use lowercase letters, digits, "-" and "_", starting with a letter or digit`,
    )
  }
  return name
}

/**
 * The directory of the function `name`, refused unless the name passes the rule and the path is a
 * direct child of the functions directory. The second check is a backstop for the first: whatever
 * the rule lets through, nothing outside `functions/` is ever written or removed.
 */
function functionDir(name: string): string {
  const root = resolve(functionsRoot())
  const dir = resolve(root, name)
  if (dirname(dir) !== root) {
    throw badRequest(`Function name ${JSON.stringify(name)} resolves outside the functions directory`)
  }
  return dir
}

/** The functions a deploy body names, every one checked before anything is written. */
function deployedFunctions(body: unknown): Array<DeployedFunction & { dir: string }> {
  const list: unknown = (body as { functions?: unknown }).functions
  if (list === undefined) return []
  if (!Array.isArray(list)) throw badRequest("functions must be an array")
  return (list as unknown[]).map((entry) => {
    const fn = (entry ?? {}) as { name?: unknown; source?: unknown }
    const name = checkedName(fn.name)
    if (typeof fn.source !== "string") throw badRequest(`Function ${name} has no source`)
    return { name, source: fn.source, dir: functionDir(name) }
  })
}

function envPath(): string {
  return join(projectRoot(), ".supatype", "function-env.json")
}

function readFunctionEnv(): Record<string, string> {
  return existsSync(envPath())
    ? JSON.parse(readFileSync(envPath(), "utf8")) as Record<string, string>
    : {}
}

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

    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { message: "Functions deployed", count: functions.length } })
  })

  route(routes, "DELETE", "/projects/:ref/functions/:name", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const name = ctx.params["name"]!
    rmSync(functionDir(checkedName(name)), { recursive: true, force: true })
    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { deleted: name } })
  })

  route(routes, "GET", "/projects/:ref/functions/env", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, { data: readFunctionEnv() })
  })

  route(routes, "POST", "/projects/:ref/functions/env", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as { key?: string; value?: string }
    if (!body.key) {
      sendJson(ctx.res, 400, { error: "validation_error", message: "key required" })
      return
    }
    const current = readFunctionEnv()
    current[body.key] = body.value ?? ""
    mkdirSync(dirname(envPath()), { recursive: true })
    writeFileSync(envPath(), `${JSON.stringify(current, null, 2)}\n`, "utf8")
    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { key: body.key } })
  })
}
