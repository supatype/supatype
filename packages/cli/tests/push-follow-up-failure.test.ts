import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { exitThrows } from "./support/process-exit.js"

/**
 * Issue 41: with the stack down, `supatype push` applied the schema and then started the rest of
 * the stack; that start failed on a port clash, so push exited 1 with the schema in, and six of the
 * stack's containers kept running. As Nic decided it, a push to a stopped stack is refused before it
 * starts anything. On a running stack, a step after the apply that fails is warned about and the
 * push exits 0. An external database is pushed to with no stack running, and nothing is started.
 */

/** The running stack's mode (undefined: none runs), and every compose command run. */
const docker = vi.hoisted(() => ({ mode: undefined as "dev" | "standalone" | undefined, compose: [] as string[][], engineRuns: 0 }))

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
  runningStackMode: () => docker.mode,
}))
// A running stack's `db` runs with it.
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: (_cwd: string, _stack: unknown, service: string) => service === "db" && docker.mode !== undefined,
}))
vi.mock("../src/dev-ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-ports.js")>()),
  ensureKongPort: async () => 55560,
  ensureDevDbPort: async () => 54777,
}))
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

/** One compose command, recorded. The stack's `up -d` fails, as a port clash does. */
function compose(args: string[]): number {
  docker.compose.push(args)
  return args.join(" ") === "up -d" ? 1 : 0
}

vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: async () => {
    docker.engineRuns += 1
    return { status: 0, stdout: "", stderr: "", output: "" }
  },
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [] }),
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

const { pushSchemaDocker } = await import("../src/dev-compose.js")

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

let cwd = ""
let printed: string[] = []

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-push-follow-up-"))
  writeFileSync(join(cwd, ".env"), "POSTGRES_PASSWORD=pw\nPOSTGRES_DB=acme\nSUPATYPE_KONG_PORT=55560\n")
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  docker.mode = undefined
  docker.compose.length = 0
  docker.engineRuns = 0
  printed = []
  const keep = (...parts: unknown[]): void => void printed.push(parts.map(String).join(" "))
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(keep)
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (keep(chunk), true))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("supatype push on a docker project", () => {
  it("refuses a stopped stack before it starts or applies anything", async () => {
    await expect(pushSchemaDocker(cwd, config, { audit: [] })).rejects.toThrow(
      "The local stack isn't running. Start it with `supatype dev`, or `supatype self-host compose up -d` on a server, then run `supatype push` again.",
    )
    expect(docker.compose).toEqual([])
    expect(docker.engineRuns).toBe(0)
  })

  it("on a running stack, exits 0 with a warning when a step after the apply fails", async () => {
    docker.mode = "dev"
    // An exit throws "exit <code>", so a push that would exit 1 fails here, saying so.
    exitThrows()
    await pushSchemaDocker(cwd, config, { audit: [] })
    expect(docker.engineRuns).toBe(1)
    expect(printed.join("\n")).toMatch(/The schema was applied, but a step after it failed/)
  })

  // Issue 46: the push ran `up -d db` (and waited on it) before applying, on a stack already up.
  it("on a running stack, does not start its database again", async () => {
    docker.mode = "dev"
    exitThrows()
    await pushSchemaDocker(cwd, config, { audit: [] })
    expect(docker.compose.filter((args) => args.join(" ") === "up -d db")).toEqual([])
  })

  it("applies to an external database with no stack running, and starts nothing", async () => {
    const external: SupatypeProjectConfig = { ...config, database: { external: { url: "postgresql://u:p@db.example.com:5432/app" } } }
    exitThrows()
    await pushSchemaDocker(cwd, external, { audit: [] })
    expect(printed.join("\n")).toMatch(/nothing else was started/)
    expect(docker.compose.filter((args) => args[0] === "up")).toEqual([])
  })
})
