import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExtractedSchemaAstV2 } from "../src/schema-ast-v2.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Issue 72: `reset` pushed the current schema with `force`, which on a database already at that
 * schema changed nothing, and then said "Reset complete." Rows survived. It now pushes a schema
 * with no models, which drops every managed table, then the real one, forgets the seed runs, and
 * seeds again unless told not to.
 */
const DSN = "postgresql://u:p@db.example.com:5432/app"

const SCHEMA = vi.hoisted(
  (): ExtractedSchemaAstV2 => ({
    astVersion: 2,
    models: [
      {
        name: "Event",
        fields: {},
        options: {},
        annotations: { db: { tableName: "event", indexes: [] }, platform: { access: {} } },
      },
    ],
    renameJournal: [
      {
        id: "r1",
        kind: "column",
        table: "event",
        from: "body",
        to: "content",
        declared_by: "nic (OS user)",
        declared_at: "2026-11-08T00:00:00Z",
      },
    ],
    storageBuckets: [{ id: "event-images", public: true }],
    locales: ["en"],
  }),
)
const pushes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const queries = vi.hoisted(() => [] as string[])
const seedRuns = vi.hoisted(() => [] as Array<{ file: string | undefined; opts: Record<string, unknown> }>)

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => "host-engine",
  // reset pushes through enginePush, whose own call to engineRequest a mock of it cannot reach.
  enginePush: async (_cwd: string, body: Record<string, unknown>) => {
    pushes.push(body)
    return { status: "applied", operations: pushes.length === 1 ? 7 : 9 }
  },
}))
vi.mock("../src/engine-ownership-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-ownership-gate.js")>()),
  engineCapabilities: async () => ({ version: "0.9.1", source: "engine", features: new Set<string>() }),
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig({ provider: "docker" }),
  loadSchemaAst: () => SCHEMA,
}))
vi.mock("../src/local-stack-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/local-stack-guard.js")>()),
  requireLocalStack: () => {},
}))
vi.mock("../src/db-rows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db-rows.js")>()),
  withDatabase: async (_url: string, use: (client: { query: (text: string) => Promise<unknown> }) => Promise<unknown>) =>
    use({
      query: async (text: string) => {
        queries.push(text)
        return { rows: [] }
      },
    }),
}))
vi.mock("../src/commands/seed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/seed.js")>()),
  runSeed: async (file: string | undefined, opts: Record<string, unknown>) => {
    seedRuns.push({ file, opts })
    return 0
  },
}))

const { registerMigrate } = await import("../src/commands/migrate.js")
const { withoutModels, resetQuestion } = await import("../src/schema-reset.js")

let dir = ""
let cwd: () => string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-reset-"))
  cwd = process.cwd
  process.cwd = () => dir
  pushes.length = 0
  queries.length = 0
  seedRuns.length = 0
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})
afterEach(() => {
  process.cwd = cwd
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function reset(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerMigrate(program)
  await program.parseAsync(["node", "supatype", "reset", "--yes", "--connection", DSN, ...args])
}

describe("reset", () => {
  it("drops the managed tables with an empty schema, then applies the real one", async () => {
    await reset("--no-seed")
    expect(pushes).toHaveLength(2)
    expect(pushes[0]).toMatchObject({ database_url: DSN, force: true })
    expect(pushes[0]?.["ast"]).toEqual({
      astVersion: 2,
      models: [],
      storageBuckets: SCHEMA.storageBuckets,
      locales: ["en"],
    })
    expect(pushes[1]).toMatchObject({ ast: SCHEMA, database_url: DSN, force: true })
  })

  it("forgets the seed runs, whose rows are gone, even with --no-seed", async () => {
    await reset("--no-seed")
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("DELETE FROM _supatype.seeds WHERE true")
    expect(seedRuns).toEqual([])
  })

  it("seeds again by default, through the database it reset", async () => {
    mkdirSync(join(dir, "seeds"))
    writeFileSync(join(dir, "seeds", "01-demo.ts"), "export default () => {}\n")
    await reset()
    expect(seedRuns).toEqual([
      { file: undefined, opts: { force: false, atomic: false, status: false, connection: DSN } },
    ])
  })

  it("says so and seeds nothing when the project has no seed file", async () => {
    await reset()
    expect(seedRuns).toEqual([])
  })
})

describe("withoutModels", () => {
  it("keeps the buckets and locales, and drops what is about the models", () => {
    const empty = withoutModels({ ...SCHEMA, defaultLocale: "en" })
    expect(empty).toEqual({
      astVersion: 2,
      models: [],
      storageBuckets: SCHEMA.storageBuckets,
      locales: ["en"],
      defaultLocale: "en",
    })
  })
})

describe("resetQuestion", () => {
  it("says what goes and what stays", () => {
    expect(resetQuestion(true)).toContain("applies the schema again and runs the seeds")
    expect(resetQuestion(false)).not.toContain("seeds")
    expect(resetQuestion(true)).toContain("Sign-ins, Studio users and stored files are kept")
  })
})
