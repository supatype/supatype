import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
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

/** What each engine does with the next push: apply it, or refuse it as destructive. */
const engine = vi.hoisted(() => ({ refuseUnforced: false, refuseAll: false, pushes: 0 }))

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
      ? { status: 1, stdout: "", stderr: REFUSAL, pid: 0, output: [], signal: null }
      : { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null }
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

vi.mock("../src/schema-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schema-sources.js")>()),
  writeSchemaSourcePushArtifacts: () => null,
}))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => false }))

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

/** How many times the engine was asked for one of the generated files. */
function generated(endpoint: "/admin" | "/generate"): number {
  return engineRequest.mock.calls.filter(([called]) => called === endpoint).length
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
  const config = projectConfig(over)
  const once = (force: boolean) =>
    runComposeSchemaPush(cwd, config, selfHostComposePaths(cwd), "schema/index.ts", "demo", { force, audit: [] })
  return {
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
  schema.ast = { version: 2, models: [] }
  engineRequest.mockReset()
  engineRequest.mockImplementation(async (endpoint) =>
    endpoint === "/generate" ? { code: "export type Pushed = 1\n" } : { models: [], pushed: true },
  )
  enginePush.mockReset()
  enginePush.mockImplementation(async (_cwd, body) => {
    engine.pushes += 1
    const refused = engine.refuseAll || (engine.refuseUnforced && body["force"] !== true)
    if (refused) throw new Error(REFUSAL)
    return { status: "applied" }
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

  it("writes them once when the first push applies", async () => {
    const { devPush } = await loadPush(over)
    await devPush()
    expect(generated("/admin")).toBe(1)
    expect(generated("/generate")).toBe(1)
    expect(JSON.parse(read(ADMIN))).toMatchObject({ pushed: true })
  })
})
