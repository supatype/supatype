import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJsonObject } from "@supatype/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { parseJsonAs } from "./support/json.js"

/**
 * Local test round 3 N4: a model hook declared while native dev ran never fired. Dev's push applied
 * the schema but wrote neither `hooks/_supatype/hooks.ts` nor the manifest's hook map, which is what
 * the server reads to call a hook; only a separate `st push` did.
 */

const enginePush = vi.hoisted(() => vi.fn<(cwd: string, body: Record<string, unknown>) => Promise<unknown>>())
const schemaAst = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: vi.fn(async () => undefined),
  engineRequest: vi.fn(async () => ({})),
  enginePush,
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => schemaAst.value,
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

const CONFIG: SupatypeProjectConfig = {
  project: { name: "demo" },
  database: { provider: "native" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

/** A schema of one model on table `notes`, with `hooks` as its hook map. */
function notesSchema(hooks: Record<string, unknown> | undefined): Record<string, unknown> {
  const platform = hooks === undefined ? {} : { hooks }
  return { version: 2, models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "notes" }, platform } }] }
}

let cwd: string

async function push(): Promise<void> {
  const { runSchemaPush } = await import("../src/commands/dev.js")
  const engineBin = join(cwd, "no-engine")
  await runSchemaPush({ cwd, engineBin, schemaPath: "schema/index.ts", dbURL: "postgres://x@127.0.0.1:1/x", config: CONFIG })
}

function manifest(): Record<string, unknown> {
  return parseJsonAs(readFileSync(join(cwd, ".supatype", "manifest.json"), "utf8"), isJsonObject)
}

beforeEach(() => {
  vi.resetModules()
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-hooks-"))
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  writeFileSync(join(cwd, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true }), "utf8")
  enginePush.mockReset()
  enginePush.mockResolvedValue({ status: "applied", operations: 1 })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev push and model hooks", () => {
  it("writes the hook map and handler types when a push declares a hook", async () => {
    schemaAst.value = notesSchema(undefined)
    await push()
    expect(manifest()["hooks"]).toBeUndefined()

    schemaAst.value = notesSchema({ beforeInsert: { function: "tag-note" } })
    await push()
    expect(manifest()["hooks"]).toEqual({
      notes: { beforeInsert: { function: "tag-note", timeout: 2000, onUnavailable: "reject" } },
    })
    expect(existsSync(join(cwd, "hooks", "_supatype", "hooks.ts"))).toBe(true)
  })

  // The first push runs before native dev records its functions, and the hook maps only ever went
  // into a manifest that exists, so a project with none had no hook map until the next push.
  it("writes the hook map on the first push of a project with no manifest yet", async () => {
    rmSync(join(cwd, ".supatype", "manifest.json"))
    schemaAst.value = notesSchema({ beforeInsert: { function: "tag-note" } })
    await push()
    expect(Object.keys(manifest()["hooks"] ?? {})).toEqual(["notes"])
  })

  // push and Docker dev write `_shared/context.ts` after a push, and native dev never did.
  it("writes the functions context module, as push does", async () => {
    mkdirSync(join(cwd, "functions", "hello"), { recursive: true })
    writeFileSync(join(cwd, "functions", "hello", "index.ts"), "export default () => new Response('hi')\n")
    schemaAst.value = notesSchema(undefined)
    await push()
    expect(existsSync(join(cwd, "functions", "_shared", "context.ts"))).toBe(true)
  })
})
