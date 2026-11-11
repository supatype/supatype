import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { interpolated, SESSION_KEYS, SESSION_RUN_ENV } from "./support/live-session.js"
import { exitThrows } from "./support/process-exit.js"
import { projectConfig } from "./support/project-config.js"

/**
 * 0.9.2 release test FF-7: `supatype dev` started with SUPATYPE_KONG_PORT=18780 and
 * SUPATYPE_DEV_DB_PORT=54780 in its shell, then `supatype push --yes` from a shell without them.
 * The push's `docker compose up -d` rendered from its own environment, so the running database was
 * recreated on 54329 and Kong on 18473, while dev kept advertising 18780. The live session's lock
 * records the ports its stack runs on, and a push to that stack keeps them.
 */

const SESSION_PROJECT = "supatype-acme"
const SESSION_KONG_PORT = 18780
const SESSION_DB_PORT = 54780

/** The values compose interpolates at each compose command run: this process's environment, then `.env`. */
interface ComposeRun {
  args: string[]
  kongPort: string | undefined
  dbPort: string | undefined
  apiUrl: string | undefined
}

const docker = vi.hoisted(() => ({ runs: [] as ComposeRun[], fetched: [] as string[] }))

/** One compose command, recorded with the ports compose would interpolate. */
function compose(args: string[]): number {
  docker.runs.push({
    args,
    kongPort: interpolated("SUPATYPE_KONG_PORT", cwd),
    dbPort: interpolated("SUPATYPE_DEV_DB_PORT", cwd),
    apiUrl: interpolated("API_EXTERNAL_URL", cwd),
  })
  return 0
}

const ANSWER = { status: 0, stdout: "", stderr: "" }
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const fake = (command: string, args: readonly string[] = []) =>
    command === "docker" ? { ...ANSWER, pid: 0, output: [], signal: null } : actual.spawnSync(command, [...args], { encoding: "utf8" })
  return { ...actual, spawnSync: fake }
})
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async () => ({ ...ANSWER, timedOut: false, missing: false }),
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  runningStackMode: () => "dev",
}))
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: (_cwd: string, _stack: unknown, service: string) => service === "db",
}))
// The ports as the real resolvers settle them when the port they read is this project's own, and
// without probing a socket: the defaults, 18473 and 54329, belong to other stacks on this machine.
vi.mock("../src/dev-ports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dev-ports.js")>()
  const { readComposeEnvInt } = await import("../src/env-file.js")
  return {
    ...actual,
    ensureKongPort: async (cwd: string) => actual.readPersistedKongPort(cwd) ?? 18473,
    ensureDevDbPort: async (cwd: string) => readComposeEnvInt(cwd, "SUPATYPE_DEV_DB_PORT") ?? 54329,
  }
})
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
  runDockerCompose: (_path: string, args: string[]) => compose(args),
  runDockerComposeQuietly: async (_path: string, args: string[]) => compose(args),
}))
vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: async () => {
    compose(["run", "--rm", "schema-engine"])
    // An empty diff, which also reads as an adopt that adopted nothing.
    return { status: 0, stdout: JSON.stringify({ operations: [] }), stderr: "", output: "" }
  },
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [], storageBuckets: [] }),
}))
vi.mock("../src/schema-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/schema-sources.js")>()),
  writeSchemaSourcePushArtifacts: () => null,
}))
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => undefined,
  engineRequest: async () => ({}),
}))
vi.mock("../src/recorded-field-masking-tier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/recorded-field-masking-tier.js")>()),
  recordDatabaseTier: async () => undefined,
}))
vi.mock("../src/commands/admin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/admin.js")>()),
  ensureFirstAdminUserForProject: async () => undefined,
}))

const { adoptSchemaDocker, diffSchemaDocker, pushSchemaDocker } = await import("../src/dev-compose.js")
const { devSessionLockFor, writeDevSessionLock } = await import("../src/dev-session-lock.js")
const { selfHostComposePaths } = await import("../src/self-host-compose.js")
const { rootProgram } = await import("../src/cli.js")

/** `action` run as the CLI runs the command `name`: on its root program, with any root flags. */
async function throughCli(name: string, action: () => Promise<unknown>, ...flags: string[]): Promise<void> {
  const program = rootProgram().exitOverride()
  program.command(name).action(async () => {
    await action()
  })
  await program.parseAsync(["node", "supatype", name, ...flags])
}

const config = projectConfig({ project: { name: "acme" }, provider: "docker", database: { provider: "docker" } })

/** What `supatype dev` sets in this process's environment for a run: none of it is set by the push's shell. */
const RUN_KEYS = SESSION_KEYS
const DOT_ENV = "POSTGRES_PASSWORD=pw\nPOSTGRES_DB=acme\n"

let cwd = ""
let originalCwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-push-session-ports-"))
  writeFileSync(join(cwd, ".env"), DOT_ENV)
  mkdirSync(join(cwd, ".supatype", "self-host"), { recursive: true })
  docker.runs.length = 0
  docker.fetched.length = 0
  vi.stubEnv("SUPATYPE_PROJECT_NAME", "")
  for (const key of RUN_KEYS) vi.stubEnv(key, "")
  vi.stubGlobal("fetch", async (url: string) => {
    docker.fetched.push(String(url))
    return Response.json({ name: "ok" })
  })
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {})
  // The session `supatype dev` holds in this folder, on the ports its own shell gave it.
  const ports = { kongPort: SESSION_KONG_PORT, dbPort: SESSION_DB_PORT, runEnv: { ...SESSION_RUN_ENV } }
  const stack = { composeProject: SESSION_PROJECT, composePath: selfHostComposePaths(cwd).composePath, ...ports }
  writeDevSessionLock(cwd, devSessionLockFor(config, stack))
  // The hook finds the session in the folder the command runs in.
  originalCwd = process.cwd()
  process.chdir(cwd)
})

afterEach(() => {
  process.chdir(originalCwd)
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("supatype push while this folder's dev session runs", () => {
  it("brings the stack up on the ports the session runs on, from a shell that names none", async () => {
    exitThrows()
    await throughCli("push", () => pushSchemaDocker(cwd, config, { audit: [] }))

    const up = docker.runs.filter((run) => run.args[0] === "up")
    expect(up.length).toBeGreaterThan(0)
    for (const run of docker.runs) {
      expect(run).toMatchObject({ kongPort: String(SESSION_KONG_PORT), dbPort: String(SESSION_DB_PORT), apiUrl: `http://localhost:${SESSION_KONG_PORT}` })
    }
    expect(docker.fetched.every((url) => url.startsWith(`http://127.0.0.1:${SESSION_KONG_PORT}/`) || url.startsWith(`http://localhost:${SESSION_KONG_PORT}/`))).toBe(true)
    // The session's ports were its shell's, and stay out of .env as dev kept them out (DR9).
    expect(readFileSync(join(cwd, ".env"), "utf8")).not.toMatch(/SUPATYPE_KONG_PORT|SUPATYPE_DEV_DB_PORT|18780|54780/)
  })

  // Round 4: a shell still exporting another Kong port moved the running gateway there, exit 0,
  // while dev and the server went on naming 18780. Another database port waited 69 s to fail.
  it.each([
    ["SUPATYPE_KONG_PORT", "18781", String(SESSION_KONG_PORT)],
    ["SUPATYPE_DEV_DB_PORT", "54781", String(SESSION_DB_PORT)],
  ])("refuses, touching nothing, when the push's shell sets %s to another port", async (key, shell, session) => {
    vi.stubEnv(key, shell)
    exitThrows()
    await expect(throughCli("push", () => pushSchemaDocker(cwd, config, { audit: [] }))).rejects.toThrow("exit 1")

    expect(docker.runs).toEqual([])
    const said = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].flat().join("\n")
    expect(said).toContain(`${key}=${shell}`)
    expect(said).toContain(session)
  })

  it("goes ahead when the push's shell sets the port the session runs on", async () => {
    vi.stubEnv("SUPATYPE_KONG_PORT", String(SESSION_KONG_PORT))
    exitThrows()
    await throughCli("push", () => pushSchemaDocker(cwd, config, { audit: [] }))
    expect(docker.runs.filter((run) => run.args[0] === "up").length).toBeGreaterThan(0)
  })

  it("leaves the ports alone when the push names another stack with --project-name", async () => {
    exitThrows()
    // The config as the CLI loads it under that name: the run's project is `other`.
    const other = { ...config, project: { name: "other" } }
    await throughCli("push", () => pushSchemaDocker(cwd, other, { audit: [] }), "--project-name", "other")

    const up = docker.runs.filter((run) => run.args[0] === "up")
    expect(up.length).toBeGreaterThan(0)
    for (const run of up) expect(run).not.toMatchObject({ kongPort: String(SESSION_KONG_PORT) })
    for (const run of up) expect(run.apiUrl).not.toBe(SESSION_RUN_ENV["API_EXTERNAL_URL"])
  })
})

/**
 * The engine's `compose run` starts the `db` it depends on, and recreates it when its published
 * port differs from the running one's, as `up -d` does. So `diff` and `adopt` from a shell without
 * dev's ports would have moved the database the same way.
 */
describe.each([
  ["diff", () => diffSchemaDocker(cwd, config)],
  ["adopt", () => adoptSchemaDocker(cwd, config, true)],
])("supatype %s while this folder's dev session runs", (name, run) => {
  it("runs the engine against the stack on the ports the session runs on", async () => {
    await throughCli(name, run)

    const engine = docker.runs.filter((r) => r.args[0] === "run")
    expect(engine).toHaveLength(1)
    expect(engine[0]).toMatchObject({ kongPort: String(SESSION_KONG_PORT), dbPort: String(SESSION_DB_PORT) })
    expect(readFileSync(join(cwd, ".env"), "utf8")).not.toMatch(/SUPATYPE_KONG_PORT|SUPATYPE_DEV_DB_PORT/)
  })
})
