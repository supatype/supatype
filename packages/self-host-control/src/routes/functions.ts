import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"

function projectRoot(): string {
  return process.env["SUPATYPE_PROJECT_ROOT"] ?? "/project"
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

export function registerFunctionRoutes(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "GET", "/projects/:ref/functions", async (ctx) => {
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
    const body = ctx.body as {
      functions?: Array<{ name: string; source: string; entrypoint?: string }>
    }
    const root = functionsRoot()
    mkdirSync(root, { recursive: true })

    for (const fn of body.functions ?? []) {
      const dir = join(root, fn.name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "index.ts"), fn.source, "utf8")
    }

    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { message: "Functions deployed", count: body.functions?.length ?? 0 } })
  })

  route(routes, "DELETE", "/projects/:ref/functions/:name", async (ctx) => {
    const name = ctx.params["name"]!
    const dir = join(functionsRoot(), name)
    if (existsSync(dir)) {
      const { rmSync } = await import("node:fs")
      rmSync(dir, { recursive: true, force: true })
    }
    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { deleted: name } })
  })

  route(routes, "GET", "/projects/:ref/functions/env", async (ctx) => {
    const envPath = join(projectRoot(), ".supatype", "function-env.json")
    if (!existsSync(envPath)) {
      sendJson(ctx.res, 200, { data: {} })
      return
    }
    sendJson(ctx.res, 200, { data: JSON.parse(readFileSync(envPath, "utf8")) })
  })

  route(routes, "POST", "/projects/:ref/functions/env", async (ctx) => {
    const body = ctx.body as { key?: string; value?: string }
    if (!body.key) {
      sendJson(ctx.res, 400, { error: "validation_error", message: "key required" })
      return
    }
    const envPath = join(projectRoot(), ".supatype", "function-env.json")
    mkdirSync(join(projectRoot(), ".supatype"), { recursive: true })
    const current = existsSync(envPath)
      ? JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string>
      : {}
    current[body.key] = body.value ?? ""
    writeFileSync(envPath, `${JSON.stringify(current, null, 2)}\n`, "utf8")
    restartFunctionsWorker()
    sendJson(ctx.res, 200, { data: { key: body.key } })
  })
}
