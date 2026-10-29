import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Native dev's push says how many operations it applied, as the docker engines do. It printed only
 * "Schema applied." although the engine's answer carries the count.
 */

const enginePush = vi.hoisted(() => vi.fn<(cwd: string, body: Record<string, unknown>) => Promise<unknown>>())

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: vi.fn(async () => undefined),
  engineRequest: vi.fn(async () => ({})),
  enginePush,
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [] }),
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

let cwd: string

async function pushOnce(): Promise<string[]> {
  vi.resetModules()
  const { runSchemaPush } = await import("../src/commands/dev.js")
  const missingEngine = join(cwd, "no-engine")
  await runSchemaPush(cwd, missingEngine, "schema/index.ts", "postgres://x@127.0.0.1:1/x")
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-push-"))
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  enginePush.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev push outcome", () => {
  it("says how many operations it applied", async () => {
    enginePush.mockResolvedValue({ status: "applied", operations: 1 })
    const printed = await pushOnce()
    expect(printed).toContain("[supatype] Applied 1 operation(s).")
    expect(printed).not.toContain("[supatype] Schema applied.")
  })

  it("says the schema was up to date when the engine applied nothing", async () => {
    enginePush.mockResolvedValue({ status: "up_to_date" })
    expect(await pushOnce()).toContain("[supatype] Schema up to date.")
  })
})
