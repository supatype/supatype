import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { FUNCTIONS_WORKER_SOURCE } from "../src/generated/functions-worker-source.js"
import {
  devFunctionsEntrySource,
  functionsServeDenoArgs,
  functionsWorkerEnv,
  installFunctionsWorker,
  localWorkerRoutes,
  writeDevFunctionsEntry,
} from "../src/functions-worker-files.js"
import { refreshNativeFunctionsEntry } from "../src/native-functions-watch.js"
import { validateProjectConfig } from "../src/project-config.js"
import { devServiceRoleKeyPath, writeServiceRoleKeyFile, writeServiceRoleKeyFileUntilExit } from "../src/service-role-key-file.js"

/**
 * Native `dev` and `functions serve` run packages/functions-worker itself, the code the deployed
 * image runs, where they used to run a router the CLI generated to copy its rules. The copy drifted
 * three times: which export it took, who it gave the service-role key, which env files it read.
 *
 * These run the worker the CLI ships the way each command runs it, under `deno run --watch`, and
 * hold it to what the router fix gave: a named `handler` export, one broken function failing alone,
 * and the service-role key only for `functions.serviceRole` routes, across reloads.
 */

const WORKER_DIR = fileURLToPath(new URL("../../functions-worker/", import.meta.url))

const denoAvailable = spawnSync("deno", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0

const children: ChildProcess[] = []
const dirs: string[] = []

/** Deno runs through a shell on Windows, and killing the shell leaves Deno holding its port. */
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A project holding `functions` (and `hooks`), and the service-role key in native dev's key file. */
interface Project {
  cwd: string
  functionsDir: string
  hooksDir: string
  workerMain: string
}

function writeFunctions(root: string, functions: Record<string, string>): void {
  for (const [name, source] of Object.entries(functions)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, "index.ts"), source)
  }
}

function project(functions: Record<string, string>, hooks: Record<string, string> = {}): Project {
  const cwd = tempDir("supatype-worker-")
  writeFunctions(join(cwd, "functions"), functions)
  writeFunctions(join(cwd, "hooks"), hooks)
  writeServiceRoleKeyFile(devServiceRoleKeyPath(cwd), "service-secret")
  const workerMain = installFunctionsWorker(tempDir("supatype-cache-"))
  return { cwd, functionsDir: join(cwd, "functions"), hooksDir: join(cwd, "hooks"), workerMain }
}

/**
 * The environment native dev's server gives Deno: its own, which carries the key itself, plus the
 * worker's. `admin` is the one function `functions.serviceRole` lists.
 */
function devEnv(p: Project): Record<string, string> {
  const config = validateProjectConfig(
    {
      project: { name: "native-parity" },
      server: {},
      app: { mode: "none" },
      database: { provider: "native" },
      functions: { serviceRole: ["admin"] },
    },
    "supatype.config.ts",
  )
  return {
    ...functionsWorkerEnv({ cwd: p.cwd, config, functionsDir: p.functionsDir, keyPath: devServiceRoleKeyPath(p.cwd) }),
    SUPATYPE_SERVICE_ROLE_KEY: "service-secret",
  }
}

const LISTENING = /listening on http:\/\/[^:]+:(\d+)/g

/** A worker under Deno, and a wait for the `times`-th match of a pattern in what it prints. */
interface RunningWorker {
  /** Resolves with the match, or rejects with the output if Deno exits or 30s pass first. */
  printed(pattern: RegExp, times: number): Promise<RegExpMatchArray>
  /** Its address once it has started `times` times (more than once only under `--watch`). */
  listening(times: number): Promise<string>
  /** How many times it has printed a pattern so far. */
  count(pattern: RegExp): number
}

/** What a child has printed so far, whether it has exited, and who to tell when either changes. */
interface CapturedOutput {
  output: () => string
  exited: () => boolean
  waiters: Set<() => void>
}

/** Collects what `child` prints, calling every waiter whenever more arrives or it exits. */
function captureOutput(child: ChildProcess): CapturedOutput {
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
  return { output: () => output, exited: () => exited, waiters }
}

/** Resolves with the `times`-th match of `pattern`, or rejects with the output on exit or after 30s. */
function waitForOutput(seen: CapturedOutput, pattern: RegExp, times: number): Promise<RegExpMatchArray> {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      seen.waiters.delete(check)
      reject(new Error(`worker did not print ${pattern} ${times} time(s):\n${seen.output()}`))
    }, 30_000)
    const check = (): void => {
      const match = [...seen.output().matchAll(global)][times - 1]
      if (match === undefined && !seen.exited()) return
      clearTimeout(timer)
      seen.waiters.delete(check)
      if (match !== undefined) resolve(match)
      else reject(new Error(`worker exited:\n${seen.output()}`))
    }
    seen.waiters.add(check)
    check()
  })
}

/** Runs `deno <args>` on a free port with `env` over this process's own environment. */
function startDeno(args: readonly string[], env: Record<string, string>): RunningWorker {
  const child = spawn("deno", [...args], { env: { ...process.env, PORT: "0", ...env }, shell: process.platform === "win32" })
  children.push(child)
  const seen = captureOutput(child)
  const printed = (pattern: RegExp, times: number): Promise<RegExpMatchArray> => waitForOutput(seen, pattern, times)
  return {
    printed,
    listening: async (times) => `http://127.0.0.1:${(await printed(LISTENING, times))[1]}`,
    count: (pattern) => [...seen.output().matchAll(new RegExp(pattern.source, "g"))].length,
  }
}

/** Native dev's worker: the entry the CLI writes, run as the server runs it. */
function startDevWorker(p: Project): RunningWorker {
  const entry = writeDevFunctionsEntry(p.cwd, localWorkerRoutes(p.functionsDir, p.hooksDir), p.workerMain)
  return startDeno(["run", "--watch", "--allow-net", "--allow-env", "--allow-read", entry], devEnv(p))
}

/** What a function reports about the key: whether its module body saw it, and what ctx gave it. */
const REPORTS_KEY = `
const seenAtImport = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null
export default (_req: Request, ctx: { serviceRoleKey?: string }) =>
  Response.json({ seenAtImport, ctxKey: ctx.serviceRoleKey ?? null, envKey: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null })
`

/** admin, which is listed, gets the key in ctx; hello does not; neither ever finds it in Deno.env. */
async function expectKeyOnlyForAdmin(base: string): Promise<void> {
  const admin: unknown = await (await fetch(`${base}/functions/v1/admin`)).json()
  const hello: unknown = await (await fetch(`${base}/functions/v1/hello`)).json()
  expect(admin).toEqual({ seenAtImport: null, ctxKey: "service-secret", envKey: null })
  expect(hello).toEqual({ seenAtImport: null, ctxKey: null, envKey: null })
}

describe("the worker the CLI ships", () => {
  it("is packages/functions-worker, every .ts file of it, as the image copies them", () => {
    const shipped = Object.keys(FUNCTIONS_WORKER_SOURCE).sort()
    expect(shipped).toEqual(readdirSync(WORKER_DIR).filter((name) => name.endsWith(".ts")).sort())
    for (const name of shipped) {
      const source = readFileSync(join(WORKER_DIR, name), "utf8").replace(/\r\n/g, "\n")
      expect(FUNCTIONS_WORKER_SOURCE[name], `${name} is stale: run node scripts/functions-worker-source.mjs generate`).toBe(source)
    }
  })

  it("reads .env files with the CLI's own parser, not a copy of its rules", () => {
    const cliParser = readFileSync(new URL("../src/dotenv-parse.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    expect(FUNCTIONS_WORKER_SOURCE["dotenv.ts"]?.endsWith(cliParser)).toBe(true)
    expect(FUNCTIONS_WORKER_SOURCE["main.ts"]).toContain('import { parseEnvText } from "./dotenv.ts"')
  })

  it("is written once per source, and rewritten when a file there was changed", () => {
    const cache = tempDir("supatype-cache-")
    const main = installFunctionsWorker(cache)
    expect(installFunctionsWorker(cache)).toBe(main)
    writeFileSync(main, "tampered")
    installFunctionsWorker(cache)
    expect(readFileSync(main, "utf8")).toBe(FUNCTIONS_WORKER_SOURCE["main.ts"])
  })

  it("is what native dev's entry imports, by file URL, with the functions it found named", () => {
    const source = devFunctionsEntrySource(["admin", "hello"], "C:\\cache\\functions-worker\\abc\\main.ts")
    expect(source).toContain('import "file:///C:/cache/functions-worker/abc/main.ts"')
    expect(source).toContain("// Routes: admin, hello")
  })

  it("is run by functions serve under --watch on the directories it is given", () => {
    expect(functionsServeDenoArgs("/c/main.ts", ["/p/functions", "/p/hooks"], ["--env-file=/p/.env"])).toEqual([
      "run", "--allow-net", "--allow-env", "--allow-read", "--watch=/p/functions,/p/hooks", "--env-file=/p/.env", "/c/main.ts",
    ])
  })
})

describe("native dev's service-role key file", () => {
  it.skipIf(process.platform === "win32")("is readable by its owner only", () => {
    const keyPath = devServiceRoleKeyPath(tempDir("supatype-key-"))
    writeServiceRoleKeyFile(keyPath, "first")
    chmodSync(keyPath, 0o644)
    writeServiceRoleKeyFile(keyPath, "second")
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(keyPath, "utf8")).toBe("second")
  })

  it("is removed again when the process exits", () => {
    const keyPath = devServiceRoleKeyPath(tempDir("supatype-key-"))
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
})

describe.skipIf(!denoAvailable)("native dev's worker under Deno", () => {
  it("serves a function whose only export is a named handler", async () => {
    const base = await startDevWorker(project({ named: `export const handler = () => new Response("named ok")\n` })).listening(1)
    expect(await (await fetch(`${base}/functions/v1/named`)).text()).toBe("named ok")
  }, 60_000)

  it("answers a function that failed to load with a 500 naming it, and serves the others", async () => {
    const base = await startDevWorker(project({
      empty: `export const other = 1\n`,
      syntax: `export default (\n`,
      throws: `throw new Error("boom-at-import")\n`,
      hello: `export default () => new Response("hello ok")\n`,
    })).listening(1)
    expect(await (await fetch(`${base}/functions/v1/hello`)).text()).toBe("hello ok")
    const failures: Record<string, RegExp> = {
      empty: /^Function "empty" failed to load: .*neither a default export nor a named "handler"/s,
      syntax: /^Function "syntax" failed to load: /,
      throws: /^Function "throws" failed to load: .*boom-at-import/s,
    }
    for (const [name, message] of Object.entries(failures)) {
      const res = await fetch(`${base}/functions/v1/${name}`)
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: "function_load_failed", message: expect.stringMatching(message) })
    }
  }, 60_000)

  it("withholds the service-role key from the environment and grants it only to listed routes", async () => {
    await expectKeyOnlyForAdmin(await startDevWorker(project({ admin: REPORTS_KEY, hello: REPORTS_KEY })).listening(1))
  }, 60_000)

  it("grants the key to a hook, which only the server can call, as the deployed worker does", async () => {
    const base = await startDevWorker(project({ hello: REPORTS_KEY }, { audit: REPORTS_KEY })).listening(1)
    expect(await (await fetch(`${base}/functions/v1/hooks/audit`)).json()).toMatchObject({ ctxKey: "service-secret", envKey: null })
  }, 60_000)

  // A reload evaluates the worker again in the same process, whose environment the first evaluation
  // took the key out of, so the key has to come from its file every time.
  it("still grants the key after deno run --watch reloads the worker", async () => {
    const p = project({ admin: REPORTS_KEY, hello: REPORTS_KEY })
    const worker = startDevWorker(p)
    await worker.listening(1)
    appendFileSync(join(p.functionsDir, "hello", "index.ts"), "\n// changed\n")
    await expectKeyOnlyForAdmin(await worker.listening(2))
  }, 60_000)

  it("still grants the key once a function that failed to load is fixed under --watch", async () => {
    const p = project({ admin: `export const other = 1\n`, hello: REPORTS_KEY })
    const worker = startDevWorker(p)
    await worker.printed(/neither a default export nor a named \\?"handler/, 1)
    await worker.listening(1)
    writeFileSync(join(p.functionsDir, "admin", "index.ts"), REPORTS_KEY)
    await expectKeyOnlyForAdmin(await worker.listening(2))
  }, 60_000)

  // An evaluation can end in ways the worker never sees coming: here a function's floating promise
  // rejects with nothing to catch it, and Deno ends the evaluation without dispatching "unload".
  it("still grants the key after an evaluation dies of an unhandled rejection under --watch", async () => {
    const p = project({ admin: REPORTS_KEY, hello: REPORTS_KEY })
    const adminPath = join(p.functionsDir, "admin", "index.ts")
    const worker = startDevWorker(p)
    await worker.listening(1)
    writeFileSync(adminPath, `Promise.reject(new Error("unhandled-boom"))\n${REPORTS_KEY}`)
    await worker.printed(/unhandled-boom/, 1)
    // Deno only watches again once it has said so; a fix saved before that is never seen.
    await worker.printed(/Restarting on file change/, 1)
    const started = worker.count(LISTENING)
    writeFileSync(adminPath, REPORTS_KEY)
    await expectKeyOnlyForAdmin(await worker.listening(started + 1))
  }, 60_000)

  it("serves a hook added while it runs, once the watch rewrites the entry", async () => {
    const p = project({ hello: REPORTS_KEY })
    const worker = startDevWorker(p)
    await worker.listening(1)
    writeFunctions(p.hooksDir, { audit: REPORTS_KEY })
    expect(refreshNativeFunctionsEntry(p, ["hello"])).toEqual(["hello", "hooks/audit"])
    const base = await worker.listening(2)
    expect(await (await fetch(`${base}/functions/v1/hooks/audit`)).json()).toMatchObject({ ctxKey: "service-secret" })
  }, 60_000)

  it("serves a project's hooks when it has no functions directory", async () => {
    const base = await startDevWorker(project({}, { audit: REPORTS_KEY })).listening(1)
    expect(await (await fetch(`${base}/functions/v1/hooks/audit`)).json()).toMatchObject({ ctxKey: "service-secret" })
  }, 60_000)

  it("serves a function added while it runs, once the watch rewrites the entry", async () => {
    const p = project({ hello: `export default () => new Response("hello ok")\n` })
    const worker = startDevWorker(p)
    await worker.listening(1)
    writeFunctions(p.functionsDir, { late: `export default () => new Response("late ok")\n` })
    expect(refreshNativeFunctionsEntry(p, ["hello"])).toEqual(["hello", "late"])
    const base = await worker.listening(2)
    expect(await (await fetch(`${base}/functions/v1/late`)).text()).toBe("late ok")
  }, 60_000)
})

describe.skipIf(!denoAvailable)("functions serve's worker under Deno", () => {
  it("serves a function added while it runs, and still grants only the listed route the key", async () => {
    const p = project({ admin: REPORTS_KEY })
    const worker = startDeno(functionsServeDenoArgs(p.workerMain, [p.functionsDir], []), devEnv(p))
    await worker.listening(1)
    writeFunctions(p.functionsDir, { hello: REPORTS_KEY })
    await worker.listening(2)
    // The folder and its file are two changes, so Deno may reload once more: ask until it settles.
    await eventually(async () => expectKeyOnlyForAdmin(await worker.listening(worker.count(LISTENING))))
  }, 60_000)
})

/** Runs `check` until it passes, for up to 15s, rethrowing its last failure. */
async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      return await check()
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
