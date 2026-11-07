import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeEngine } from "../src/engine-client.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Issue 63: `diff`, `push` and `seed` ran the project's engine image, while `migrate`, `reset` and
 * `pull` ran the engine binary cached on the host. With an engine image chosen, `migrate` wrote SQL
 * from the released 0.9.0 engine that the push no longer ran. On the stack's own database each of
 * them now runs the engine push runs, as do `migrations list` and `rollback`; a `--connection`
 * elsewhere keeps the host binary.
 */
const STACK_DSN = "postgresql://u:p@127.0.0.1:54777/app"

const composeEngine = vi.hoisted(
  (): ComposeEngine => ({
    target: { cwd: "", project: "p", composePath: "", engineImage: "img" },
    databaseUrl: "postgresql://db/app",
    capabilities: async () => ({ version: "0.9.1", source: "engine", features: new Set<string>() }),
  }),
)
const engineCalls = vi.hoisted(() => [] as Array<{ endpoint: string; engine: ComposeEngine | undefined }>)
const ANSWERS: Record<string, unknown> = {
  "/migrate": { sql: "-- planned" },
  "/push": { message: "Reset complete." },
  "/introspect": { tables: [] },
  "/migrations": { migrations: [] },
}

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => "host-engine",
  engineRequest: async (endpoint: string, _body: unknown, _guard: unknown, engine?: ComposeEngine) => {
    engineCalls.push({ endpoint, engine })
    return ANSWERS[endpoint]
  },
}))
vi.mock("../src/engine-ownership-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-ownership-gate.js")>()),
  engineCapabilities: async () => ({ version: "0.9.0", source: "engine", features: new Set<string>() }),
}))
vi.mock("../src/dev-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-compose.js")>()),
  projectComposeEngine: async () => composeEngine,
  resolveHostEngineDatabaseUrl: async (_cwd: string, _config: unknown, explicit?: string) => explicit ?? STACK_DSN,
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderMode: () => "dev",
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig({ provider: "docker" }),
  loadSchemaAst: () => ({ models: [] }),
}))
vi.mock("../src/local-stack-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/local-stack-guard.js")>()),
  requireLocalStack: () => {},
}))
vi.mock("../src/host-database.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host-database.js")>()),
  resolveHostDatabaseUrl: (_cwd: string, _config: unknown, opts: { connection?: string }) => ({
    dsn: opts.connection ?? STACK_DSN,
    source: "test",
  }),
}))

const { registerMigrate } = await import("../src/commands/migrate.js")
const { registerPull } = await import("../src/commands/pull.js")

let dir = ""
let cwd: () => string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-stack-engine-"))
  writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=54777\n")
  vi.stubEnv("SUPATYPE_DEV_DB_PORT", undefined)
  cwd = process.cwd
  process.cwd = () => dir
  engineCalls.length = 0
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
})
afterEach(() => {
  process.cwd = cwd
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerMigrate(program)
  registerPull(program)
  await program.parseAsync(["node", "supatype", ...args])
}

describe("commands that reach the stack's database run the engine push runs", () => {
  it.each([
    ["migrate", ["migrate"], "/migrate"],
    ["reset", ["reset", "--yes"], "/push"],
    ["pull", ["pull", "--dry-run"], "/introspect"],
    ["migrations list", ["migrations", "list"], "/migrations"],
  ])("%s runs the project's engine image", async (_name, args, endpoint) => {
    await run(...args)
    expect(engineCalls).toEqual([{ endpoint, engine: composeEngine }])
  })

  it("keeps the host binary for a --connection to another database", async () => {
    await run("migrate", "--connection", "postgresql://u:p@db.example.com:5432/app")
    expect(engineCalls).toEqual([{ endpoint: "/migrate", engine: undefined }])
  })
})
