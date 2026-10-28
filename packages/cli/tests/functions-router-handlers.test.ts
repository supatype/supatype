import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generateFunctionsRouterSource } from "../src/functions-router-gen.js"

/**
 * The router native `dev` and `functions serve` run has to load and guard handlers the way the
 * deployed worker (packages/functions-worker/main.ts) does, or a function that works locally fails
 * once deployed, or the other way round.
 *
 * Two differences used to exist. The router accepted only `export default`, where the worker also
 * takes a named `handler` export. And it handed every function the service-role key, both in
 * `ctx.serviceRoleKey` and ambiently in `Deno.env`, where the worker withholds it before importing any
 * handler and grants it only to the routes `functions.serviceRole` lists, and to hooks.
 */

const ROUTER = generateFunctionsRouterSource("/project/.supatype/functions-router.ts", [
  { name: "admin", entrypoint: "/project/functions/admin/index.ts" },
  { name: "hello", entrypoint: "/project/functions/hello/index.ts" },
])

describe("the generated router's source", () => {
  it("imports handlers dynamically, after the key is out of the environment", () => {
    // A static import is hoisted above every statement, so a module body would run before the
    // delete and could copy the key. A dynamic import runs where it is written.
    expect(ROUTER).not.toMatch(/^import handler_\d+ from /m)
    const deleted = ROUTER.indexOf('Deno.env.delete("SUPATYPE_SERVICE_ROLE_KEY")')
    const firstImport = ROUTER.indexOf("await import(")
    expect(deleted).toBeGreaterThan(-1)
    expect(firstImport).toBeGreaterThan(deleted)
  })

  it("takes the default export, else a named handler", () => {
    expect(ROUTER).toContain("SUPATYPE_SERVICE_ROLE_ROUTES")
    expect(ROUTER).toMatch(/\.default\b[^\n]*\?\?[^\n]*\.handler\b/)
  })
})

const denoAvailable = spawnSync("deno", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0

const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project with the given functions and its generated router; returns the router's path. */
function project(functions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-router-"))
  dirs.push(dir)
  const fns = Object.entries(functions).map(([name, source]) => {
    mkdirSync(join(dir, "functions", name), { recursive: true })
    const entrypoint = join(dir, "functions", name, "index.ts")
    writeFileSync(entrypoint, source)
    return { name, entrypoint }
  })
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  const routerPath = join(dir, ".supatype", "functions-router.ts")
  writeFileSync(routerPath, generateFunctionsRouterSource(routerPath, fns))
  return routerPath
}

/** Runs the router under Deno on a free port and resolves with its address, or rejects with its output. */
function serve(routerPath: string, env: Record<string, string>): Promise<string> {
  const child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", routerPath], {
    env: { ...process.env, PORT: "0", ...env },
    shell: process.platform === "win32",
  })
  children.push(child)
  let output = ""
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`router did not start:\n${output}`)), 30_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const port = /listening on http:\/\/[^:]+:(\d+)/.exec(output)?.[1]
      if (port !== undefined) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${port}`)
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("exit", () => {
      clearTimeout(timer)
      reject(new Error(`router exited:\n${output}`))
    })
  })
}

/** What a function reports about the key: whether its module body saw it, and what ctx gave it. */
const REPORTS_KEY = `
const seenAtImport = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null
export default (_req: Request, ctx: { serviceRoleKey?: string }) =>
  Response.json({ seenAtImport, ctxKey: ctx.serviceRoleKey ?? null, envKey: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null })
`

describe.skipIf(!denoAvailable)("the generated router under Deno", () => {
  it("serves a function whose only export is a named handler", async () => {
    const base = await serve(
      project({ named: `export const handler = () => new Response("named ok")\n` }),
      {},
    )
    const res = await fetch(`${base}/functions/v1/named`)
    expect(await res.text()).toBe("named ok")
  }, 60_000)

  it("refuses to start, naming the function, when it exports neither", async () => {
    await expect(serve(project({ empty: `export const other = 1\n` }), {})).rejects.toThrow(
      /"empty".*neither a default export nor a named "handler"/s,
    )
  }, 60_000)

  it("withholds the service-role key from the environment and grants it only to listed routes", async () => {
    const base = await serve(project({ admin: REPORTS_KEY, hello: REPORTS_KEY }), {
      SUPATYPE_SERVICE_ROLE_KEY: "service-secret",
      SUPATYPE_SERVICE_ROLE_ROUTES: "admin",
    })
    const admin = await (await fetch(`${base}/functions/v1/admin`)).json()
    const hello = await (await fetch(`${base}/functions/v1/hello`)).json()
    expect(admin).toEqual({ seenAtImport: null, ctxKey: "service-secret", envKey: null })
    expect(hello).toEqual({ seenAtImport: null, ctxKey: null, envKey: null })
  }, 60_000)
})
