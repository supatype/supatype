import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype push` and `deploy` to a linked Cloud project send the project's platform settings after
 * the schema, as a step that can fail on its own: the schema is in, the push says it did not finish
 * and exits 1. A self-host target is sent nothing, and a config that sets none of them sends nothing.
 */

const state = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string; body?: unknown }>,
  failPlatform: false,
  config: undefined as unknown,
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => state.config,
  loadSchemaAst: () => ({ version: 2, models: [], storageBuckets: [] }),
}))
vi.mock("../src/model-hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/model-hooks.js")>()),
  validateModelHooks: () => [],
  validateModelValidators: () => [],
  manifestMaps: () => ({ hooks: {}, validators: {}, cache: {}, tables: {} }),
  syncManifestHooks: () => false,
  writeHooksModule: () => null,
}))
vi.mock("../src/service-role-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/service-role-check.js")>()),
  checkServiceRoleRoutes: () => ({ warnings: [], missing: [] }),
  serviceRoleProblemLines: () => [],
}))
vi.mock("../src/engine-floor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-floor.js")>()),
  assertEngineSupportsSchema: () => undefined,
}))
vi.mock("../src/schema-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schema-sources.js")>()),
  buildSchemaSourcesPayload: () => null,
}))
// A linked push now writes the project's types; this file is about the platform settings, so the engine is not run.
vi.mock("../src/type-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-generation.js")>()),
  writeGeneratedTypes: async () => [],
}))
vi.mock("../src/rest-ready.js", () => ({ waitForRestReady: async () => true }))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: { method: string; path: string; body?: unknown }) => {
    state.requests.push({ method: opts.method, path: opts.path, body: opts.body })
    if (state.failPlatform && opts.path.endsWith("/platform-settings")) throw new Error("control plane unreachable")
    return {}
  },
}))
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  targetSchemaDiff: async () => ({ operations: [] }),
  targetSchemaPush: async () => ({ status: "up_to_date" }),
  requireTargetFeatures: async () => undefined,
  schemaPgSchema: () => "public",
}))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))

const { rootProgram } = await import("../src/cli.js")
const { registerPush } = await import("../src/commands/push.js")
const { deploySchemaToLinkedProject } = await import("../src/commands/cloud.js")

let dir = ""
let originalCwd = ""
let said: string[] = []

function linkTo(kind: "self-host" | "cloud"): void {
  const environment = { name: "production", apiUrl: "https://prod.example.test", token: "prod-token", linkedAt: "x" }
  const link = { version: 1, kind, projectRef: "acme", defaultEnvironment: "production", linkedAt: "x", environments: { production: environment } }
  const cloud = kind === "cloud" ? { token: "pat", orgId: "org1", cloudApiUrl: "https://api.example.test" } : {}
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify({ ...link, ...cloud }))
}

async function supatype(register: (program: Command) => void, ...args: string[]): Promise<void> {
  const program = rootProgram().exitOverride()
  register(program)
  await program.parseAsync(["node", "supatype", ...args])
}

const platformRequests = () => state.requests.filter((r) => /platform-settings|storage-bucket/.test(r.path))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-platform-push-"))
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  originalCwd = process.cwd()
  process.chdir(dir)
  state.requests.length = 0
  state.failPlatform = false
  state.config = projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" }, services: { storage: false } })
  said = []
  for (const key of ["SUPATYPE_PROJECT_NAME", "SUPATYPE_ACCESS_TOKEN"]) vi.stubEnv(key, "")
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
  process.exitCode = undefined
})

afterEach(() => {
  process.chdir(originalCwd)
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("supatype push to a linked Cloud project", () => {
  it("sends the platform settings after the schema", async () => {
    linkTo("cloud")
    await supatype(registerPush, "push", "--yes")
    expect(platformRequests()).toEqual([{ method: "PUT", path: "/projects/acme/platform-settings", body: { services: { storage: false }, realtime: {} } }])
    expect(process.exitCode).toBeUndefined()
  })

  it("sends nothing for a config that sets none of them", async () => {
    state.config = projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" } })
    linkTo("cloud")
    await supatype(registerPush, "push", "--yes")
    expect(platformRequests()).toEqual([])
  })

  it("ends as unfinished and exits 1 when the settings were not applied, the schema being in", async () => {
    state.failPlatform = true
    linkTo("cloud")
    await supatype(registerPush, "push", "--yes")
    expect(process.exitCode).toBe(1)
    const text = said.join("\n")
    expect(text).toContain("The schema was applied, but the platform settings")
    expect(text).toContain("did not finish")
    expect(text).not.toContain("Pushed to Supatype Cloud")
  })
})

describe("supatype push to a linked self-host project", () => {
  it("sends it nothing: it reads the same settings from its compose file", async () => {
    linkTo("self-host")
    await supatype(registerPush, "push", "--yes")
    expect(platformRequests()).toEqual([])
  })
})

describe("supatype deploy to a linked Cloud project", () => {
  it("sends the platform settings after the schema", async () => {
    linkTo("cloud")
    await deploySchemaToLinkedProject(dir, "production")
    expect(platformRequests().map((r) => r.path)).toEqual(["/projects/acme/platform-settings"])
  })

  it("exits 1 when they were not applied", async () => {
    state.failPlatform = true
    linkTo("cloud")
    await deploySchemaToLinkedProject(dir, "production")
    expect(process.exitCode).toBe(1)
    expect(said.join("\n")).toContain("The schema was applied, but the platform settings")
  })
})
