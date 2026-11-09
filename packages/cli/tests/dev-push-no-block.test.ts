import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FakeRun } from "./support/fake-exec-file.js"

/**
 * A schema save froze the dev dashboard for as long as the push took: the engine's push, `parse`
 * and `admin` each ran through `spawnSync`, on the host binary and in the compose engine image
 * alike, so no timer fired and no process's output appeared until the push was done. Here every
 * engine run takes a second, whichever way it is started, and a timer set for 50 ms as the first of
 * them starts has to fire before it finishes. The push still answers as it did.
 */
const { RUN_MS, ENGINE, events, timer, GIT, answers } = vi.hoisted(() => ({
  RUN_MS: 1_000,
  ENGINE: "/fake/supatype-engine",
  events: [] as string[],
  timer: { armed: false },
  GIT: { "user.name": "Ada Lovelace\n", "user.email": "ada@example.com\n" } as Record<string, string>,
  answers: {
    push: JSON.stringify({ status: "applied", operations: 1 }),
    parse: JSON.stringify({ storageBuckets: [] }),
    admin: JSON.stringify({ models: [] }),
  } as Record<string, string>,
}))

/** Which faked program `cmd` is, and the run's name for the event list. */
function faked(cmd: string, args: readonly string[]): string | undefined {
  if (cmd === "git") return `git ${args.at(-1) ?? ""}`
  if (cmd === ENGINE) return `engine ${args[0] ?? ""}`
  if (/(^|[\\/])docker(\.exe)?$/.test(cmd)) return `docker ${args.includes("schema-engine") ? "engine" : (args[0] ?? "")}`
  return undefined
}

/** Records that `name` started, setting the timer off with the first run of a test. */
function started(name: string): void {
  events.push(`${name} started`)
  if (timer.armed) return
  timer.armed = true
  setTimeout(() => events.push("timer"), 50)
}

function answerFor(name: string, args: readonly string[]): FakeRun {
  if (name.startsWith("git")) return { status: 0, stdout: GIT[args.at(-1) ?? ""] ?? "", stderr: "" }
  const sub = name.startsWith("docker") ? args[args.indexOf("schema-engine") + 1] ?? "" : (args[0] ?? "")
  return { status: 0, stdout: answers[sub] ?? "{}", stderr: "" }
}

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>()
  const { fakeExecFile } = await import("./support/fake-exec-file.js")
  const spawnSyncFake = (cmd: string, args: readonly string[] = []): FakeRun & { pid: number; output: null[]; signal: null } => {
    const name = faked(cmd, args)
    if (name === undefined) return { status: 1, stdout: "", stderr: `not faked: ${cmd}`, pid: 0, output: [], signal: null }
    started(name)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RUN_MS)
    events.push(`${name} done`)
    return { ...answerFor(name, args), pid: 0, output: [], signal: null }
  }
  const execFileFake = fakeExecFile(async (cmd, args) => {
    const name = faked(cmd, args)
    if (name === undefined) return { status: null, error: `not faked: ${cmd}` }
    started(name)
    await new Promise((resolve) => setTimeout(resolve, RUN_MS))
    events.push(`${name} done`)
    return answerFor(name, args)
  }, () => new real.ChildProcess())
  const execFileSyncFake = (cmd: string, args: readonly string[] = []): string => {
    const run = spawnSyncFake(cmd, args)
    if (run.status !== 0) throw new Error(run.stderr ?? `exit ${run.status ?? "null"}`)
    return run.stdout ?? ""
  }
  return { ...real, spawnSync: spawnSyncFake, execFile: execFileFake, execFileSync: execFileSyncFake }
})

vi.mock("../src/ensure-binary.js", () => ({ ensureBinary: async () => ENGINE }))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  hasProjectConfig: () => true,
  loadConfig: () => ({}),
  loadSchemaAst: () => ({ version: 2, models: [] }),
}))
vi.mock("../src/engine-ownership-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-ownership-gate.js")>()),
  binaryCapabilities: () => ({ features: new Set<string>(), source: "engine" }),
}))
vi.mock("../src/schema-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schema-sources.js")>()),
  writeSchemaSourcePushArtifacts: () => null,
}))
vi.mock("../src/type-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-generation.js")>()),
  writeGeneratedTypes: async () => [],
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

const { runSchemaPush } = await import("../src/commands/dev.js")
const { spawnComposeEngine } = await import("../src/compose-engine-run.js")
const { auditWhenSupported } = await import("../src/push-audit.js")
const { grantAuthSchemaAccess } = await import("../src/compose-db-roles.js")
const { recordDatabaseTier } = await import("../src/recorded-field-masking-tier.js")

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-push-no-block-"))
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  events.length = 0
  timer.armed = false
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

/** Runs `work`, then waits out the timer the first run set, and returns the events in order. */
async function withTimer(work: () => Promise<unknown>): Promise<string[]> {
  await work()
  await new Promise((resolve) => setTimeout(resolve, 100))
  return [...events]
}

describe("a native dev push", () => {
  it("lets a timer fire while the engine runs, and still pushes, parses and writes the admin config", async () => {
    const adminConfigPath = join(cwd, ".supatype", "admin-config.json")
    const seen = await withTimer(() =>
      runSchemaPush({
        cwd,
        engineBin: ENGINE,
        schemaPath: "schema/index.ts",
        dbURL: "postgres://x@127.0.0.1:1/x",
        adminConfigPath,
        storagePath: join(cwd, ".supatype", "storage"),
      }),
    )
    expect(seen).toEqual([
      "engine push started",
      "timer",
      "engine push done",
      "engine parse started",
      "engine parse done",
      "engine admin started",
      "engine admin done",
    ])
    expect(JSON.parse(readFileSync(adminConfigPath, "utf8"))).toEqual({ models: [] })
  }, 20_000)
})

describe("the compose engine run", () => {
  it("lets a timer fire while it runs, and answers with the run's output", async () => {
    const target = { cwd, project: "p", composePath: join(cwd, "compose.yml"), engineImage: "supatype/schema-engine:test" }
    let answered: { status: number | null; stdout: string } | undefined
    const seen = await withTimer(async () => {
      answered = await spawnComposeEngine(target, ["push"], { runFlags: ["-T"] })
    })
    expect(seen).toEqual(["docker engine started", "timer", "docker engine done"])
    expect(answered).toMatchObject({ status: 0, stdout: answers["push"] })
  }, 20_000)
})

describe("a push's audit fields", () => {
  it("lets a timer fire while git says who is pushing, and names them", async () => {
    vi.stubEnv("SUPATYPE_PUSHED_BY", "")
    const capabilities = async () => ({ features: new Set(["push_audit"]), source: "engine" as const })
    let audit: Awaited<ReturnType<typeof auditWhenSupported>>
    const seen = await withTimer(async () => {
      audit = await auditWhenSupported(cwd, capabilities)
    })
    vi.unstubAllEnvs()
    expect(seen.indexOf("timer")).toBeGreaterThan(-1)
    expect(seen.indexOf("timer")).toBeLessThan(seen.findIndex((event) => event.endsWith(" done")))
    expect(audit).toMatchObject({ pushed_by: "Ada Lovelace <ada@example.com>", pushed_via: "cli" })
  }, 20_000)
})

describe("the auth.users grant after a docker push", () => {
  it("lets a timer fire while psql runs in the database container", async () => {
    const paths = { composePath: join(cwd, "compose.yml") }
    const seen = await withTimer(() => grantAuthSchemaAccess(paths, cwd, "p"))
    expect(seen).toEqual(["docker compose started", "timer", "docker compose done"])
  }, 20_000)
})

describe("reading the field-masking tier a docker push recorded", () => {
  it("lets a timer fire while psql runs in the database container", async () => {
    const stack = { project: "p", composePath: join(cwd, "compose.yml") }
    const seen = await withTimer(() => recordDatabaseTier(cwd, stack))
    expect(seen).toEqual(["docker compose started", "timer", "docker compose done"])
  }, 20_000)
})
