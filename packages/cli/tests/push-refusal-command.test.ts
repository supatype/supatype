import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * C08: the diff `push` reads first showed no drift, a policy was hand-edited while the person
 * answered "Proceed?", and the push itself came back `security_drift`. The CLI printed the engine's
 * error and exited 1 without the question it asks when the diff shows the same drift.
 */

const targetSchemaPush = vi.hoisted(() => vi.fn())
const askMock = vi.hoisted(() => vi.fn(async () => true))
const interactive = vi.hoisted(() => ({ value: true }))

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/model-versioning.js", () => ({ withPublishing: (ast: unknown) => ast }))
vi.mock("../src/model-hooks.js", () => ({
  validateModelHooks: () => [],
  validateModelValidators: () => [],
  syncManifestHooks: () => false,
  writeHooksModule: () => null,
}))
vi.mock("../src/hook-upload.js", () => ({ readHookUpload: () => null, adapterEntry: () => null }))
vi.mock("../src/service-role-check.js", () => ({
  checkServiceRoleRoutes: () => ({ warnings: [], missing: [] }),
  serviceRoleProblemLines: () => [],
}))
vi.mock("../src/engine-floor.js", () => ({ assertEngineSupportsSchema: () => undefined }))
vi.mock("../src/binary-cache.js", () => ({ pinnedVersion: () => undefined }))
vi.mock("../src/preview-config-check.js", () => ({
  modelsWithUnresolvablePreview: () => [],
  unresolvablePreviewMessage: () => "",
}))
vi.mock("../src/project-config.js", () => ({
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
vi.mock("../src/resolve-target.js", () => ({
  resolveTarget: () => ({ mode: "self-host", environment: "prod", projectRef: "app", link: null }),
  targetSchemaDiff: async () => ({ operations: [], reconcile: [] }),
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
const { EngineError } = await import("../src/engine-client.js")
const { TargetApiError } = await import("../src/target-client.js")

const OBJECTS = [{ key: { kind: "policy", schema: "public", parent: "post", name: "post_select" }, recorded: "USING (true)", live: "USING (false)" }]
const DRIFT = { status: "refused", reason: "security_drift", objects: OBJECTS }
const STDERR = "1 object(s) that decide who may read or write were changed outside Supatype"

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
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe.each([
  ["the engine binary (direct, local)", () => new EngineError(`Engine /push failed (exit 1): Error: ${STDERR}`, "/push", 1, JSON.stringify(DRIFT))],
  ["a server's 409 (linked, self-host)", () => new TargetApiError(STDERR, 409, "security_drift", { ...DRIFT, code: "security_drift" })],
])("C08: a push refused with security_drift from %s", (_label, refusal) => {
  it("shows what drifted and asks; a yes pushes again with overwrite_drift", async () => {
    targetSchemaPush.mockImplementationOnce(async () => {
      throw refusal()
    })
    targetSchemaPush.mockImplementationOnce(async () => ({ status: "applied", message: "Applied 0 operation(s)." }))
    await push()
    expect(askMock).toHaveBeenCalledWith("Put Supatype's definitions back?", expect.anything())
    expect(targetSchemaPush.mock.calls.map((call) => call[2].overwriteDrift)).toEqual([false, true])
    expect(printed.join("\n")).toContain("post.post_select")
    expect(process.exitCode).toBeUndefined()
  })

  it("a no applies nothing more and exits 1, keeping the hand edit", async () => {
    askMock.mockResolvedValueOnce(false)
    targetSchemaPush.mockImplementation(async () => {
      throw refusal()
    })
    await push()
    expect(targetSchemaPush).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })

  it("without a terminal it never asks, and names --overwrite-drift", async () => {
    interactive.value = false
    targetSchemaPush.mockImplementation(async () => {
      throw refusal()
    })
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    await expect(push()).rejects.toThrow("exit")
    expect(exit).toHaveBeenCalledWith(1)
    expect(askMock).not.toHaveBeenCalled()
    expect(printed.join("\n")).toContain("`supatype push --overwrite-drift`")
    expect(printed.join("\n")).toContain("post.post_select")
  })
})
