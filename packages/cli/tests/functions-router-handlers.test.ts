import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  devServiceRoleKeyPath,
  generateFunctionsRouterSource,
  writeServiceRoleKeyFile,
  writeServiceRoleKeyFileUntilExit,
} from "../src/functions-router-gen.js"

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
    const firstImport = ROUTER.indexOf('import("')
    expect(deleted).toBeGreaterThan(-1)
    expect(firstImport).toBeGreaterThan(deleted)
  })

  it("reads the key from the file it names, not from the environment it withholds it from", () => {
    const withFile = generateFunctionsRouterSource("C:\\p\\.supatype\\functions-router.ts", [], "C:\\p\\.supatype\\service-role-key")
    expect(withFile).toContain('const serviceRoleKeyFile = "C:\\\\p\\\\.supatype\\\\service-role-key"')
    expect(ROUTER).toContain('const serviceRoleKeyFile = ""')
    expect(ROUTER).not.toMatch(/serviceRoleKey = Deno\.env\.get/)
  })

  it.skipIf(process.platform === "win32")("writes the key file readable by its owner only", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-key-"))
    dirs.push(dir)
    const keyPath = devServiceRoleKeyPath(dir)
    writeServiceRoleKeyFile(keyPath, "first")
    chmodSync(keyPath, 0o644)
    writeServiceRoleKeyFile(keyPath, "second")
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(keyPath, "utf8")).toBe("second")
  })

  it("removes the key file again when the process exits", () => {
    // The key used to stay in .supatype/ after dev or functions serve stopped.
    const dir = mkdtempSync(join(tmpdir(), "supatype-key-"))
    dirs.push(dir)
    const keyPath = devServiceRoleKeyPath(dir)
    const before = process.listeners("exit")
    writeServiceRoleKeyFileUntilExit(keyPath, "k")
    const added = process.listeners("exit").filter((listener) => !before.includes(listener))
    expect(added).toHaveLength(1)
    expect(existsSync(keyPath)).toBe(true)
    for (const listener of added) {
      process.removeListener("exit", listener)
      listener.call(process, 0)
    }
    expect(existsSync(keyPath)).toBe(false)
  })

  it("takes the default export, else a named handler", () => {
    expect(ROUTER).toContain("SUPATYPE_SERVICE_ROLE_ROUTES")
    expect(ROUTER).toMatch(/\.default\b[^\n]*\?\?[^\n]*\.handler\b/)
  })
})

const denoAvailable = spawnSync("deno", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0

const children: ChildProcess[] = []
const dirs: string[] = []

/**
 * On Windows `deno` is started through a shell, and killing the shell leaves Deno running and
 * holding its port, so the whole process tree goes.
 */
function stop(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    child.kill()
  }
}

afterEach(() => {
  for (const child of children.splice(0)) stop(child)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A project with the given functions, the service-role key in the file native dev keeps it in, and
 * its generated router; returns the router's path.
 */
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
  const keyPath = devServiceRoleKeyPath(dir)
  writeServiceRoleKeyFile(keyPath, "service-secret")
  writeFileSync(routerPath, generateFunctionsRouterSource(routerPath, fns, keyPath))
  return routerPath
}

const LISTENING = /listening on http:\/\/[^:]+:(\d+)/g

/** A router under Deno, and a wait for the `times`-th match of a pattern in what it prints. */
interface RunningRouter {
  /** Resolves with the match, or rejects with the output if the router exits or 30s pass first. */
  printed(pattern: RegExp, times: number): Promise<RegExpMatchArray>
  /** Its address once it has started `times` times (more than once only under `--watch`). */
  listening(times: number): Promise<string>
  /** How many times it has printed a pattern so far. */
  count(pattern: RegExp): number
}

/** Runs the router under Deno on a free port. */
function startRouter(
  routerPath: string,
  env: Record<string, string>,
  flags: readonly string[] = [],
): RunningRouter {
  const child = spawn("deno", ["run", ...flags, "--allow-net", "--allow-env", "--allow-read", routerPath], {
    env: { ...process.env, PORT: "0", ...env },
    shell: process.platform === "win32",
  })
  children.push(child)
  let output = ""
  let exited = false
  const waiters = new Set<() => void>()
  const onData = (chunk: Buffer): void => {
    output += chunk.toString()
    for (const check of waiters) check()
  }
  child.stdout?.on("data", onData)
  child.stderr?.on("data", onData)
  child.on("exit", () => {
    exited = true
    for (const check of waiters) check()
  })
  const printed = (pattern: RegExp, times: number): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`router did not print ${pattern} ${times} time(s):\n${output}`))
      }, 30_000)
      const check = (): void => {
        const match = [...output.matchAll(global)][times - 1]
        if (match === undefined && !exited) return
        clearTimeout(timer)
        waiters.delete(check)
        if (match !== undefined) resolve(match)
        else reject(new Error(`router exited:\n${output}`))
      }
      waiters.add(check)
      check()
    })
  return {
    printed,
    listening: async (times) => `http://127.0.0.1:${(await printed(LISTENING, times))[1]}`,
    count: (pattern) => [...output.matchAll(new RegExp(pattern.source, "g"))].length,
  }
}

/** Runs the router once and resolves with its address, or rejects with its output. */
function serve(routerPath: string, env: Record<string, string>): Promise<string> {
  return startRouter(routerPath, env).listening(1)
}

/** The deployed functions worker, run from source as its image runs it. */
const WORKER_MAIN = fileURLToPath(new URL("../../functions-worker/main.ts", import.meta.url))

/** What a server answers for one function: status, content type and parsed body. */
async function loadFailureAnswer(base: string, name: string): Promise<{ status: number; contentType: string | null; body: unknown }> {
  const res = await fetch(`${base}/functions/v1/${name}`)
  return { status: res.status, contentType: res.headers.get("content-type"), body: await res.json() }
}

/** What a function reports about the key: whether its module body saw it, and what ctx gave it. */
const REPORTS_KEY = `
const seenAtImport = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null
export default (_req: Request, ctx: { serviceRoleKey?: string }) =>
  Response.json({ seenAtImport, ctxKey: ctx.serviceRoleKey ?? null, envKey: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null })
`

// The key is also in the environment, as native dev's server passes its own to the Deno child, and
// has to be withheld all the same. The router reads the one it grants from the project's key file.
const ADMIN_GRANTED = { SUPATYPE_SERVICE_ROLE_KEY: "service-secret", SUPATYPE_SERVICE_ROLE_ROUTES: "admin" }

/** admin, which is listed, gets the key in ctx; hello does not; neither ever finds it in Deno.env. */
async function expectKeyOnlyForAdmin(base: string): Promise<void> {
  const admin = await (await fetch(`${base}/functions/v1/admin`)).json()
  const hello = await (await fetch(`${base}/functions/v1/hello`)).json()
  expect(admin).toEqual({ seenAtImport: null, ctxKey: "service-secret", envKey: null })
  expect(hello).toEqual({ seenAtImport: null, ctxKey: null, envKey: null })
}

describe.skipIf(!denoAvailable)("the generated router under Deno", () => {
  it("serves a function whose only export is a named handler", async () => {
    const base = await serve(
      project({ named: `export const handler = () => new Response("named ok")\n` }),
      {},
    )
    const res = await fetch(`${base}/functions/v1/named`)
    expect(await res.text()).toBe("named ok")
  }, 60_000)

  // One function that failed to load used to stop the router starting, so every function answered
  // 502. Now only its own route fails, with why.
  it("answers a function that failed to load with a 500 naming why, and serves the others", async () => {
    const base = await serve(
      project({
        empty: `export const other = 1\n`,
        syntax: `export default (\n`,
        throws: `throw new Error("boom-at-import")\n`,
        hello: `export default () => new Response("hello ok")\n`,
      }),
      {},
    )
    expect(await (await fetch(`${base}/functions/v1/hello`)).text()).toBe("hello ok")
    const failures: Record<string, RegExp> = {
      empty: /"empty" failed to load: .*neither a default export nor a named "handler"/s,
      syntax: /"syntax" failed to load: /,
      throws: /"throws" failed to load: .*boom-at-import/s,
    }
    for (const [name, message] of Object.entries(failures)) {
      const res = await fetch(`${base}/functions/v1/${name}`)
      expect(res.status).toBe(500)
      const body: unknown = await res.json()
      expect(body).toMatchObject({ error: "function_load_failed", message: expect.stringMatching(message) })
    }
  }, 60_000)

  // The deployed worker answers the same failure with its own copy of this code
  // (packages/functions-worker/main.ts). Both serve one functions dir here, so the two cannot drift.
  it("answers a function that failed to load exactly as the deployed worker does", async () => {
    const routerPath = project({
      empty: `export const other = 1\n`,
      throws: `throw new Error("boom-at-import")\n`,
    })
    const functionsRoot = join(dirname(dirname(routerPath)), "functions")
    const [router, worker] = await Promise.all([
      serve(routerPath, {}),
      serve(WORKER_MAIN, { SUPATYPE_FUNCTIONS_ROOT: functionsRoot }),
    ])
    for (const name of ["empty", "throws"]) {
      const fromRouter = await loadFailureAnswer(router, name)
      expect(fromRouter).toEqual(await loadFailureAnswer(worker, name))
      expect(fromRouter).toMatchObject({
        status: 500,
        contentType: "application/json",
        body: { error: "function_load_failed", message: expect.stringMatching(`^Function "${name}" failed to load: `) },
      })
    }
  }, 60_000)

  it("withholds the service-role key from the environment and grants it only to listed routes", async () => {
    await expectKeyOnlyForAdmin(await serve(project({ admin: REPORTS_KEY, hello: REPORTS_KEY }), ADMIN_GRANTED))
  }, 60_000)

  // Native dev and functions serve run the router under --watch. A reload evaluates the router again
  // in the same process, whose environment the first evaluation took the key out of, and with a fresh
  // globalThis, so nothing the first evaluation kept in JavaScript survives.
  it("still grants the key after deno run --watch reloads the router", async () => {
    const routerPath = project({ admin: REPORTS_KEY, hello: REPORTS_KEY })
    const router = startRouter(routerPath, ADMIN_GRANTED, ["--watch"])
    await router.listening(1)
    appendFileSync(routerPath, "\n// changed\n")
    await expectKeyOnlyForAdmin(await router.listening(2))
  }, 60_000)

  it("still grants the key once a function that failed to load is fixed under --watch", async () => {
    const routerPath = project({ admin: `export const other = 1\n`, hello: REPORTS_KEY })
    const router = startRouter(routerPath, ADMIN_GRANTED, ["--watch"])
    await router.printed(/neither a default export nor a named "handler"/, 1)
    await router.listening(1)
    writeFileSync(join(dirname(dirname(routerPath)), "functions", "admin", "index.ts"), REPORTS_KEY)
    await expectKeyOnlyForAdmin(await router.listening(2))
  }, 60_000)

  // An evaluation can end in ways the router never sees coming: here a function's floating promise
  // rejects with nothing to catch it, and Deno ends the evaluation without dispatching "unload".
  it("still grants the key after an evaluation dies of an unhandled rejection under --watch", async () => {
    const routerPath = project({ admin: REPORTS_KEY, hello: REPORTS_KEY })
    const adminPath = join(dirname(dirname(routerPath)), "functions", "admin", "index.ts")
    const router = startRouter(routerPath, ADMIN_GRANTED, ["--watch"])
    await router.listening(1)
    writeFileSync(adminPath, `Promise.reject(new Error("unhandled-boom"))\n${REPORTS_KEY}`)
    await router.printed(/unhandled-boom/, 1)
    const started = router.count(LISTENING)
    writeFileSync(adminPath, REPORTS_KEY)
    await expectKeyOnlyForAdmin(await router.listening(started + 1))
  }, 60_000)
})
