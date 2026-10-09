import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Every command that hands the schema to the engine sends the project's publishing settings beside
 * a versioned model, as `push` does.
 *
 * The engine refuses a versioned schema that carries none rather than default who may read drafts,
 * so a command that forgets fails outright on any project with `versions`: `doctor` and `adopt`
 * did, exiting 1 with "the push carried no `publishing` config".
 */

const VERSIONED_AST = {
  astVersion: 2,
  models: [
    {
      name: "Post",
      fields: {},
      options: { versions: true },
      annotations: { db: { tableName: "post" } },
    },
  ],
}

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => ({}),
  loadSchemaAst: () => structuredClone(VERSIONED_AST),
}))

vi.mock("../src/link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/link.js")>()),
  loadProjectLink: () => null,
}))

const target = { mode: "direct", databaseUrl: "postgres://localhost/test" }
const sent: { command: string; ast: unknown }[] = []

vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => target,
  schemaCommandTarget: async () => target,
  requireTargetFeatures: async () => {},
  targetCapabilities: async () => ({ features: new Set<string>() }),
  schemaPgSchema: () => "public",
  targetSchemaDoctor: vi.fn(async (_target: unknown, ast: unknown) => {
    sent.push({ command: "doctor", ast })
    return { missing: [], staleManaged: [], unmanagedDrift: [] }
  }),
  targetSchemaAdopt: vi.fn(async (_target: unknown, ast: unknown) => {
    sent.push({ command: "adopt", ast })
    return { status: "preview", stampStatements: [] }
  }),
}))

vi.mock("../src/ui/messages.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const quiet = Object.fromEntries(Object.keys(original).map((name) => [name, () => {}]))
  return { ...original, ...quiet }
})

vi.mock("../src/ui/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/progress.js")>()),
  withSpinner: async (_label: string, run: () => Promise<unknown>) => run(),
}))

const { registerDoctor } = await import("../src/commands/doctor.js")
const { registerAdopt } = await import("../src/commands/adopt.js")

async function run(register: (program: Command) => void, args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  register(program)
  await program.parseAsync(["node", "supatype", ...args, "--connection", "postgres://localhost/test"])
}

afterEach(() => {
  sent.length = 0
  vi.clearAllMocks()
})

describe("a versioned schema carries its publishing settings to the engine", () => {
  it("doctor", async () => {
    await run(registerDoctor, ["doctor"])
    expect(sent.map((s) => s.command)).toContain("doctor")
    for (const { ast } of sent) expect(ast).toHaveProperty("publishing.draftVisibility")
  })

  it("adopt", async () => {
    await run(registerAdopt, ["adopt"])
    expect(sent.map((s) => s.command)).toContain("adopt")
    for (const { ast } of sent) expect(ast).toHaveProperty("publishing.draftVisibility")
  })
})
