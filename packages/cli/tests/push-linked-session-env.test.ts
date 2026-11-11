import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SESSION_KEYS, SESSION_RUN_ENV } from "./support/live-session.js"
import { projectConfig } from "./support/project-config.js"

/**
 * FF-7 follow-up: a project keeps a local stack and a production one, self-host or cloud. While
 * `supatype dev` runs in the folder, a command aimed at production must not see dev's local ports
 * or URLs: not in its environment, not in what it sends. Only a path that settles on the local
 * stack takes them.
 */

const config = projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" } })
const sent = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => config,
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
vi.mock("../src/rest-ready.js", () => ({ waitForRestReady: async () => true }))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (...args: unknown[]) => {
    sent.calls.push(args)
    return {}
  },
}))
// resolveTarget stays real: it reads the link this folder holds.
vi.mock("../src/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve-target.js")>()),
  targetSchemaDiff: async (...args: unknown[]) => {
    sent.calls.push(args)
    return { operations: [] }
  },
  targetSchemaPush: async (...args: unknown[]) => {
    sent.calls.push(args)
    return { status: "up_to_date" }
  },
  requireTargetFeatures: async () => undefined,
  schemaPgSchema: () => "public",
}))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))

const { rootProgram } = await import("../src/cli.js")
const { registerPush } = await import("../src/commands/push.js")
const { registerEnvs } = await import("../src/commands/link-helpers.js")
const { devSessionLockFor, writeDevSessionLock } = await import("../src/dev-session-lock.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")

let dir = ""
let originalCwd = ""

/** The link `supatype link` writes for production, self-host or cloud. */
function linkTo(kind: "self-host" | "cloud"): void {
  const environment = { name: "production", apiUrl: "https://prod.example.test", token: "prod-token", linkedAt: "x" }
  const link = { version: 1, kind, projectRef: "acme", defaultEnvironment: "production", linkedAt: "x", environments: { production: environment } }
  const cloud = kind === "cloud" ? { token: "pat", orgId: "org1", cloudApiUrl: "https://api.example.test" } : {}
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify({ ...link, ...cloud }))
}

/** `args` run by the CLI's own root program, with `register`'s commands on it. */
async function supatype(register: (program: Command) => void, ...args: string[]): Promise<void> {
  const program = rootProgram().exitOverride()
  register(program)
  await program.parseAsync(["node", "supatype", ...args])
}

/** The session values this run's environment holds: none, from a shell that sets none. */
function sessionValuesInEnv(): Record<string, string> {
  return Object.fromEntries(SESSION_KEYS.flatMap((key) => (process.env[key] ? [[key, process.env[key] ?? ""]] : [])))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-linked-session-"))
  mkdirSync(join(dir, ".supatype", "self-host"), { recursive: true })
  originalCwd = process.cwd()
  process.chdir(dir)
  sent.calls.length = 0
  for (const key of ["SUPATYPE_PROJECT_NAME", "SUPATYPE_ACCESS_TOKEN", ...SESSION_KEYS]) vi.stubEnv(key, "")
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {})
  // `supatype dev` runs in this folder, on ports its shell gave it.
  const stack = { composeProject: "supatype-acme", composePath: selfHostComposePaths(dir).composePath, kongPort: 18780, dbPort: 54780 }
  writeDevSessionLock(dir, devSessionLockFor(config, { ...stack, runEnv: { ...SESSION_RUN_ENV } }))
  process.exitCode = undefined
})

afterEach(() => {
  process.chdir(originalCwd)
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe.each(["self-host", "cloud"] as const)("supatype push to a linked %s project while dev runs here", (kind) => {
  it("takes none of the dev session's local ports or URLs, and sends none", async () => {
    linkTo(kind)
    await supatype(registerPush, "push", "--yes")

    expect(sent.calls.length).toBeGreaterThan(0)
    expect(sessionValuesInEnv()).toEqual({})
    expect(JSON.stringify(sent.calls)).not.toMatch(/18780|54780/)
  })
})

describe("a command that does not touch the local stack, while dev runs here", () => {
  it("leaves this run's environment as its shell gave it (envs list)", async () => {
    linkTo("self-host")
    await supatype(registerEnvs, "envs", "list")

    expect(sessionValuesInEnv()).toEqual({})
  })
})
