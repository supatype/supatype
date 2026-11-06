import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TargetCall } from "./support/engine-mocks.js"

/**
 * `supatype push` shows what each API role may do on each model's table before it applies or asks
 * (issue 16), in a terminal and with `--yes` alike.
 */

const planned = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

const targetSchemaPush = vi.hoisted(() => vi.fn<TargetCall<{ overwriteDrift?: boolean }>>())
const askMock = vi.hoisted(() => vi.fn(async () => true))
const interactive = vi.hoisted(() => ({ value: true }))

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/model-versioning.js", () => ({ withPublishing: (ast: unknown) => ast }))
vi.mock("../src/model-hooks.js", () => ({
  validateModelHooks: () => [],
  validateModelValidators: () => [],
  // A cache declaration, so the push has something to deploy to the target after the schema.
  manifestMaps: () => ({ hooks: {}, validators: {}, cache: { post: { enabled: true } }, tables: {} }),
  syncManifestHooks: () => false,
  writeHooksModule: () => null,
}))
vi.mock("../src/hook-upload.js", () => ({ readHookUpload: () => null, adapterEntry: () => null }))
vi.mock("../src/service-role-check.js", () => ({
  checkServiceRoleRoutes: () => ({ warnings: [], missing: [] }),
  serviceRoleProblemLines: () => [],
}))
vi.mock("../src/engine-floor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-floor.js")>()),
  assertEngineSupportsSchema: () => undefined,
}))
vi.mock("../src/binary-cache.js", () => ({ pinnedVersion: () => undefined }))
vi.mock("../src/preview-config-check.js", () => ({
  modelsWithUnresolvablePreview: () => [],
  unresolvablePreviewMessage: () => "",
}))
// Partial: modules this loads read project-config's constants as they load.
vi.mock("../src/project-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/project-config.js")>()),
  hooksPathFromProject: () => "hooks",
  resolveRuntimeProvider: () => "native",
  schemaPathFromProject: () => "schema/index.ts",
  serverBaseUrl: () => undefined,
}))
vi.mock("../src/link.js", () => ({ loadProjectLink: () => ({ projectRef: "app" }) }))
vi.mock("../src/schema-sources.js", () => ({
  buildSchemaSourcesPayload: () => null,
  cacheSchemaSourcesLocally: () => undefined,
}))
// Waiting for the linked server's REST API is rest-ready.test.ts's subject, not this one's.
vi.mock("../src/rest-ready.js", () => ({ waitForRestReady: async () => true }))
// A self-host push sends its hook, validator and cache maps after the schema; the stack takes them.
const hooksDeploy = vi.hoisted(() => ({ fails: false }))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async () => {
    if (hooksDeploy.fails) throw new Error("Route not found")
    return {}
  },
}))
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  // projectRequest and the rest stay real: the hook upload builds its request with them.
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({
    mode: "self-host",
    environment: "prod",
    projectRef: "app",
    apiBaseUrl: "https://app.example.test",
    link: null,
  }),
  targetSchemaDiff: async () => planned.value,
  targetSchemaPush,
  targetSchemaAdopt: vi.fn(),
  requireTargetFeatures: async () => undefined,
  schemaPgSchema: () => "public",
}))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => interactive.value }))
vi.mock("../src/ui/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/confirm.js")>()),
  confirm: askMock,
}))

const { registerPush } = await import("../src/commands/push.js")


async function push(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerPush(program)
  await program.parseAsync(["node", "supatype", "push", ...args])
}

let printed: string[]

beforeEach(() => {
  printed = []
  targetSchemaPush.mockReset()
  askMock.mockClear()
  interactive.value = true
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void printed.push(a.join(" ")))
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void printed.push(a.join(" ")))
  process.exitCode = undefined
  hooksDeploy.fails = false
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const ACCESS = [{ model: "Question", table: "question", role: "anon", before: [], after: ["read"] }]
const BLOCK = "Access for anon (signed out):\n  question   none -> read\n"

describe("supatype push shows each role's access before it applies", () => {
  beforeEach(() => {
    targetSchemaPush.mockImplementation(async () => ({ status: "applied", message: "Applied 1 operation(s)." }))
  })

  it("before asking about a risky change, in a terminal", async () => {
    planned.value = { operations: [{ type: "drop_column", table: "question", column: "old", risk: "danger" }], access: ACCESS }
    let shownWhenAsked = ""
    askMock.mockImplementationOnce(async () => {
      shownWhenAsked = printed.join("\n")
      return true
    })
    await push()
    expect(askMock).toHaveBeenCalled()
    expect(shownWhenAsked).toContain(BLOCK)
  })

  it("with --yes, before the push is sent", async () => {
    planned.value = { operations: [{ type: "add_column", table: "question", column: "hint", risk: "safe" }], access: ACCESS }
    let shownWhenSent = ""
    targetSchemaPush.mockImplementationOnce(async () => {
      shownWhenSent = printed.join("\n")
      return { status: "applied", message: "Applied 1 operation(s)." }
    })
    await push("--yes")
    expect(shownWhenSent).toContain(BLOCK)
  })

  it("when the schema matches the database too", async () => {
    planned.value = { operations: [], reconcile: [], access: ACCESS }
    let shownWhenSent = ""
    targetSchemaPush.mockImplementationOnce(async () => {
      shownWhenSent = printed.join("\n")
      return { status: "up_to_date" }
    })
    await push("--yes")
    expect(shownWhenSent).toContain(BLOCK)
  })
})
