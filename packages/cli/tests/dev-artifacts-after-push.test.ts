import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { isJsonObject } from "@supatype/shared"
import { projectConfig } from "./support/project-config.js"

/**
 * The files that describe the schema (admin-config.json, the generated types, the client) are
 * written only once a push has applied it. They used to be written before the push, so a push the
 * engine refused left Studio offering fields the database did not have: a field whose bucket was
 * never created, and an upload to it answering "Bucket not found". A refused push followed by
 * `--yes` also wrote every file twice.
 *
 * Driven through both engines `dev` and `push` use on a docker project: the host binary
 * (`overrides.engine`) and the schema-engine container.
 */

const REFUSAL = "3 destructive operation(s) detected. Nothing was applied. Use --force to apply."

/** The engine's refusal of a push over a policy someone removed by hand: its JSON line, then stderr. */
const SECURITY_DRIFT_REFUSAL = [
  JSON.stringify({
    status: "refused",
    reason: "security_drift",
    objects: [{ key: { kind: "policy", schema: "public", parent: "attendee", name: "attendee_update" }, recorded: "USING (true)", live: null }],
  }),
  "Error: 1 object(s) that decide who may read or write were changed outside Supatype; pass --overwrite-drift to put Supatype's definitions back.",
].join("\n")

/** What each engine does with the next push: apply it, answering `applied`, or refuse it with `refusal`. */
const engine = vi.hoisted(() => ({
  refuseUnforced: false,
  refuseAll: false,
  pushes: 0,
  refusal: "",
  applied: { status: "applied" } as Record<string, unknown>,
}))

/** The schema the next push reads, so a test can change it and put it back. */
const schema = vi.hoisted((): { ast: { version: number; models: string[] } } => ({ ast: { version: 2, models: [] } }))

const engineRequest = vi.hoisted(() => vi.fn<(endpoint: string, body: unknown) => Promise<unknown>>())
const enginePush = vi.hoisted(() => vi.fn<(cwd: string, body: Record<string, unknown>) => Promise<unknown>>())

vi.mock("../src/engine-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine-client.js")>()
  return { ...actual, ensureEngine: vi.fn(async () => undefined), engineRequest, enginePush }
})

/** The compose engine's push: refused or applied on the same terms as the host binary's. */
vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: (_target: unknown, args: readonly string[]) => {
    engine.pushes += 1
    const refused = engine.refuseAll || (engine.refuseUnforced && !args.includes("--force"))
    return refused
      ? { status: 1, stdout: "", stderr: engine.refusal, pid: 0, output: [], signal: null }
      : { status: 0, stdout: JSON.stringify(engine.applied), stderr: "", pid: 0, output: [], signal: null }
  },
}))

vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: () => false,
}))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  schemaEngineImageForPush: async () => "supatype/schema-engine:test",
  writeSelfHostCompose: (cwd: string) => ({
    dir: join(cwd, ".supatype", "self-host"),
    composePath: join(cwd, ".supatype", "self-host", "docker-compose.yml"),
    kongPath: "",
    nginxPath: "",
    s3ConfigPath: "",
  }),
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => schema.ast,
}))

/** `snapshotOptional` as each push passed it: dev's may go without the snapshot, push's may not. */
const snapshotOptional = vi.hoisted((): boolean[] => [])
vi.mock("../src/schema-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schema-sources.js")>()),
  writeSchemaSourcePushArtifacts: (_cwd: string, optional: boolean) => {
    snapshotOptional.push(optional)
    return null
  },
}))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

// No stack runs for these projects, and none may be asked about. Each push asked the real Docker
// for a running `supatype-demo` server (`docker ps`) about once a test: a second or more apiece on
// a loaded machine, and an answer that depended on what that machine happened to be running.
const NO_STACK = { devSessionLocked: () => false, runningServerMode: () => undefined }
vi.mock("../src/compose-render-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compose-render-mode.js")>()
  return {
    ...actual,
    runningStackMode: (cwd: string, name: string) => actual.runningStackMode(cwd, name, NO_STACK),
    composeRenderMode: (cwd: string, name: string) => actual.composeRenderMode(cwd, name, NO_STACK),
    composeRenderOptions: (cwd: string, name: string) => actual.composeRenderOptions(cwd, name, NO_STACK),
  }
})

// Every test imports dev-compose afresh (see loadPush), and the first import transforms its whole
// module graph: 6 to 7 seconds alone, past 22 in a loaded suite, all charged to whichever test ran
// first, which then hit the 30 second timeout. Loaded once here, while the file is collected and no
// test's clock runs, the transforms are cached and each test's import only evaluates the modules.
await Promise.all([
  import("../src/dev-compose.js"),
  import("../src/destructive-consent.js"),
  import("../src/drift-consent.js"),
  import("../src/dev-initial-push.js"),
])

const ADMIN = ".supatype/admin-config.json"
const TYPES = "types/database.ts"
const CLIENT = "supatype/generated/index.d.ts"

let cwd: string

/** A project whose generated files describe the schema already applied. */
function seedApplied(): void {
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  mkdirSync(join(cwd, "types"), { recursive: true })
  writeFileSync(join(cwd, ADMIN), "APPLIED-ADMIN")
  writeFileSync(join(cwd, TYPES), "APPLIED-TYPES")
}

function read(path: string): string {
  return readFileSync(join(cwd, path), "utf8")
}

/**
 * How many times the engine was asked for one of the generated files. `/generate` counts the types
 * only: the seed builder is the same endpoint with `artifact: "seed"`, and has tests of its own.
 */
function generated(endpoint: "/admin" | "/generate"): number {
  return engineRequest.mock.calls.filter(([called, body]) => called === endpoint && artifactOf(body) !== "seed").length
}

/** The `artifact` a `/generate` request asked for, if any. */
function artifactOf(body: unknown): unknown {
  return isJsonObject(body) ? body["artifact"] : undefined
}

const HOST_ENGINE: Partial<SupatypeProjectConfig> = {
  provider: "docker",
  overrides: { engine: "/opt/supatype-engine" },
  database: { external: { url: "postgres://app:secret@127.0.0.1:1/app" } },
}
const COMPOSE_ENGINE: Partial<SupatypeProjectConfig> = { provider: "docker" }

async function loadPush(over: Partial<SupatypeProjectConfig>) {
  // A fresh module each test: the push remembers the last AST it applied.
  vi.resetModules()
  const { runComposeSchemaPush, schemaChangedSinceLastPush } = await import("../src/dev-compose.js")
  const { pushConsentingToDestructive, DEV_DESTRUCTIVE_POLICY } = await import("../src/destructive-consent.js")
  const { selfHostComposePaths } = await import("../src/self-host-compose.js")
  const { devPushConsentingToDrift } = await import("../src/drift-consent.js")
  const { pushInitialSchema, settleInitialPush } = await import("../src/dev-initial-push.js")
  const config = projectConfig(over)
  const once = (force: boolean, overwriteDrift = false) =>
    runComposeSchemaPush(cwd, config, selfHostComposePaths(cwd), "schema/index.ts", "demo", {
      force,
      overwriteDrift,
      audit: [],
    })
  /** A save in a `dev` session, as dev pushes it: asked about drift and data loss, off a terminal. */
  const devSave = () =>
    devPushConsentingToDrift((overwrite) => pushConsentingToDestructive((force) => once(force, overwrite), DEV_DESTRUCTIVE_POLICY), false)
  const noop = async () => undefined
  return {
    /** `supatype dev` starting: its first push, then whether dev carries on (false) or applied (true). */
    devStart: async () =>
      settleInitialPush(await pushInitialSchema({ push: devSave, recoverDatabase: noop, dumpLogs: () => undefined, sleep: noop }), {
        beforeExit: () => undefined,
      }),
    devSave,
    /** `supatype push --yes`: unforced first, then forced on the engine's refusal. */
    pushYes: () => pushConsentingToDestructive(once, { yes: true, apply: "supatype push --yes" }),
    /** One push of a `dev` session, off a terminal: a destructive change is refused. */
    devPush: () => pushConsentingToDestructive(once, DEV_DESTRUCTIVE_POLICY),
    /** What dev's watch asks when it starts: was the schema saved since the last push read it? */
    changedSinceLastPush: () => schemaChangedSinceLastPush("schema/index.ts", cwd, config),
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-artifacts-"))
  seedApplied()
  engine.refuseUnforced = false
  engine.refuseAll = false
  engine.pushes = 0
  engine.refusal = REFUSAL
  engine.applied = { status: "applied" }
  schema.ast = { version: 2, models: [] }
  engineRequest.mockReset()
  engineRequest.mockImplementation(async (endpoint) =>
    endpoint === "/generate" ? { code: "export type Pushed = 1\n" } : { models: [], pushed: true },
  )
  enginePush.mockReset()
  enginePush.mockImplementation(async (_cwd, body) => {
    engine.pushes += 1
    const refused = engine.refuseAll || (engine.refuseUnforced && body["force"] !== true)
    if (refused) throw new Error(engine.refusal)
    return engine.applied
  })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe.each([
  ["the host engine (overrides.engine)", HOST_ENGINE],
  ["the compose schema-engine", COMPOSE_ENGINE],
])("generated files around a push through %s", (_name, over) => {
  it("leaves admin-config.json, the types and the client alone when dev's push is refused", async () => {
    engine.refuseAll = true
    const { devPush } = await loadPush(over)
    await expect(devPush()).rejects.toThrow(/Nothing was applied/)
    expect(read(ADMIN)).toBe("APPLIED-ADMIN")
    expect(read(TYPES)).toBe("APPLIED-TYPES")
    expect(existsSync(join(cwd, CLIENT))).toBe(false)
    expect(generated("/admin")).toBe(0)
    expect(generated("/generate")).toBe(0)
  })

  it("leaves them alone when push --yes still fails", async () => {
    engine.refuseAll = true
    const { pushYes } = await loadPush(over)
    await expect(pushYes()).rejects.toThrow(/destructive/)
    expect(read(ADMIN)).toBe("APPLIED-ADMIN")
    expect(read(TYPES)).toBe("APPLIED-TYPES")
    expect(generated("/admin")).toBe(0)
  })

  it("takes the schema snapshot as push's, which refuses a name restore would refuse", async () => {
    snapshotOptional.length = 0
    const { pushYes } = await loadPush(over)
    await pushYes()
    expect(snapshotOptional).toEqual([false])
  })

  it("writes them exactly once when push --yes applies after the engine's refusal", async () => {
    engine.refuseUnforced = true
    const { pushYes } = await loadPush(over)
    await pushYes()
    expect(generated("/admin")).toBe(1)
    expect(generated("/generate")).toBe(1)
    expect(JSON.parse(read(ADMIN))).toMatchObject({ pushed: true })
    expect(read(TYPES)).toContain("export type Pushed")
    expect(existsSync(join(cwd, CLIENT))).toBe(true)
  })

  it("prints no \"Applying schema\" line of its own: the command's spinner says it once", async () => {
    const { pushYes } = await loadPush(over)
    await pushYes()
    const printed = vi.mocked(console.log).mock.calls.flat().join(" ")
    expect(printed).not.toMatch(/applying schema/i)
  })

  it("says how many operations the push applied, when the engine says", async () => {
    engine.applied = { status: "applied", operations: 1 }
    const { devPush } = await loadPush(over)
    await devPush()
    const printed = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(printed).toContain("[supatype] Applied 1 operation(s).")
    expect(printed).not.toContain("[supatype] Schema applied.")
  })

  it("pushes again when a refused change is put back, so the engine can clear the refusal", async () => {
    const { devPush } = await loadPush(over)
    await devPush()
    schema.ast = { version: 2, models: ["a field dropped"] }
    engine.refuseAll = true
    await expect(devPush()).rejects.toThrow(/Nothing was applied/)
    const beforeRevert = engine.pushes
    schema.ast = { version: 2, models: [] }
    engine.refuseAll = false
    await devPush()
    expect(engine.pushes).toBe(beforeRevert + 1)
  })

  it("does not push a schema that has not changed since it applied", async () => {
    const { devPush } = await loadPush(over)
    await devPush()
    const afterFirst = engine.pushes
    await devPush()
    expect(engine.pushes).toBe(afterFirst)
  })

  it("says so when a save has nothing to push, so dev does not look hung", async () => {
    const { devPush } = await loadPush(over)
    await devPush()
    const log = vi.mocked(console.log)
    log.mockClear()
    await devPush()
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(
      "[supatype] Schema unchanged since the last push, nothing to apply.",
    )
  })

  it("knows when the schema was saved after the last push read it, applied or refused", async () => {
    const { devPush, changedSinceLastPush } = await loadPush(over)
    await devPush()
    expect(changedSinceLastPush()).toBe(false)
    schema.ast = { version: 2, models: ["a field dropped"] }
    expect(changedSinceLastPush()).toBe(true)
    engine.refuseAll = true
    await expect(devPush()).rejects.toThrow(/Nothing was applied/)
    expect(changedSinceLastPush()).toBe(false)
  })

  it("keeps dev running on a first push refused for security drift, and applies the save that follows", async () => {
    engine.refusal = SECURITY_DRIFT_REFUSAL
    engine.refuseAll = true
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    const { devStart, devSave } = await loadPush(over)
    expect(await devStart()).toBe(false)
    expect(exit).not.toHaveBeenCalled()
    expect(read(ADMIN)).toBe("APPLIED-ADMIN")
    // The drift was put back from another terminal (`supatype push --overwrite-drift`), then saved.
    engine.refuseAll = false
    const beforeSave = engine.pushes
    await devSave()
    expect(engine.pushes).toBe(beforeSave + 1)
    expect(JSON.parse(read(ADMIN))).toMatchObject({ pushed: true })
  })

  it("writes them once when the first push applies", async () => {
    const { devPush } = await loadPush(over)
    await devPush()
    expect(generated("/admin")).toBe(1)
    expect(generated("/generate")).toBe(1)
    expect(JSON.parse(read(ADMIN))).toMatchObject({ pushed: true })
  })
})

describe.each([
  ["the host engine (overrides.engine)", HOST_ENGINE],
  ["the compose schema-engine", COMPOSE_ENGINE],
])("the seed builder after a push through %s", (_name, over) => {
  // Fresh-user test C2: supatype.config.ts says the outputs are regenerated by dev, push and
  // generate, and the seed builder was regenerated only by generate. After dev's first push it
  // still described the two starter models, so a seed for any model added since did not typecheck.
  it("is regenerated beside the client when the push applies", async () => {
    engineRequest.mockImplementation(async (endpoint, body) => {
      if (endpoint !== "/generate") return { models: [], pushed: true }
      return { code: artifactOf(body) === "seed" ? "export const seedBuilder = 1\n" : "export type Pushed = 1\n" }
    })
    const { devPush } = await loadPush(over)
    await devPush()
    expect(read("supatype/generated/seed.ts")).toBe("export const seedBuilder = 1\n")
  })

  it("is left alone when the push is refused", async () => {
    engine.refuseAll = true
    const { devPush } = await loadPush(over)
    await expect(devPush()).rejects.toThrow(/Nothing was applied/)
    expect(existsSync(join(cwd, "supatype/generated/seed.ts"))).toBe(false)
  })
})

/**
 * Decision (local test round 3, N7 follow-up): Docker dev's type refresh uses the host engine that
 * `supatype generate` uses, its pin or `overrides.engine`, not the project's compose engine image.
 * The image is the fallback only when the host program cannot be fetched.
 */
describe("the engine docker dev refreshes the generated files with", () => {
  it("is the host engine for a project with no override, not the compose image", async () => {
    const { pushYes } = await loadPush(COMPOSE_ENGINE)
    await pushYes()
    const writes = engineRequest.mock.calls.filter(([endpoint]) => endpoint === "/generate" || endpoint === "/admin")
    expect(writes.length).toBeGreaterThan(0)
    // engineRequest(endpoint, body, guard, engine): the fourth argument is the compose engine, if any.
    for (const call of writes) expect((call as readonly unknown[])[3]).toBeUndefined()
  })
})

/** Second review: what dev's refresh writes when the engine is refused or cannot be fetched. */
describe("docker dev's refresh without its usual engine", () => {
  /** Make the host engine fail with `error`, counting calls from here (the mock outlives a test). */
  async function hostEngineFails(error: Error): Promise<ReturnType<typeof vi.fn>> {
    const { ensureEngine } = await import("../src/engine-client.js")
    const mocked = vi.mocked(ensureEngine)
    mocked.mockReset()
    mocked.mockRejectedValue(error)
    return mocked
  }

  /** The host program could not be fetched, as `ensureBinary` says it. */
  async function offline(): Promise<Error> {
    const { BinaryUnavailable } = await import("../src/ensure-binary.js")
    return new BinaryUnavailable("fetch failed: offline")
  }

  afterEach(async () => {
    const { ensureEngine } = await import("../src/engine-client.js")
    vi.mocked(ensureEngine).mockReset()
    vi.mocked(ensureEngine).mockResolvedValue(undefined)
  })

  it("still writes the client and augmentation, which need no engine, when the engine is refused", async () => {
    const { pushYes } = await loadPush(COMPOSE_ENGINE)
    await hostEngineFails(new Error("This CLI needs Supatype engine 0.8.0 or newer"))
    await pushYes()
    expect(existsSync(join(cwd, CLIENT))).toBe(true)
    expect(generated("/generate")).toBe(0)
  })

  it("writes with the image under SUPATYPE_STRICT, then fails the run with the true reason", async () => {
    vi.stubEnv("SUPATYPE_STRICT", "1")
    try {
      const { pushYes } = await loadPush(COMPOSE_ENGINE)
      await hostEngineFails(await offline())
      await expect(pushYes()).rejects.toThrow(/could not be fetched.*fetch failed: offline/s)
      expect(generated("/generate")).toBe(1)
      expect(generated("/admin")).toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("asks for the host engine once in an offline session, not on every save", async () => {
    const { pushYes } = await loadPush(COMPOSE_ENGINE)
    const ensureEngine = await hostEngineFails(await offline())
    await pushYes()
    schema.ast = { version: 3, models: [] }
    await pushYes()
    expect(generated("/generate")).toBe(2)
    expect(ensureEngine).toHaveBeenCalledTimes(1)
  })
})
