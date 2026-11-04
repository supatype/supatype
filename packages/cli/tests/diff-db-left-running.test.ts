import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Fresh-user test: `supatype diff` is a dry run, and it started the project's compose Postgres to
 * read the live schema and left it running. The database is stopped again after the diff, but only
 * when the diff was what started it: one a `supatype dev` session was already using is left alone.
 *
 * Both engines diff reaches the database through: the schema-engine container, and the host binary
 * (`overrides.engine`), whose database is published to the host first.
 */

/** Whether compose reports the `db` service running, and every compose command run. */
const docker = vi.hoisted(() => ({ dbRunning: false, healthFails: false, compose: [] as string[][] }))

const ANSWER = { status: 0, stdout: "", stderr: "" }
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const fake = (command: string, args: readonly string[] = []) => {
    if (command !== "docker") return actual.spawnSync(command, [...args], { encoding: "utf8" })
    // The project's server container, which `requireRunningStack` asks after, runs in dev mode.
    if (args[0] === "ps") return { ...ANSWER, stdout: "c0ffee\n" }
    if (args[0] === "inspect") return { ...ANSWER, stdout: "SUPATYPE_MODE=dev\n" }
    return ANSWER
  }
  return { ...actual, spawnSync: fake }
})
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async () => {
    // The health wait after `up -d db`: a start that fails once the container exists.
    if (docker.healthFails) throw new Error("docker exec failed")
    return { ...ANSWER, timedOut: false, missing: false }
  },
}))
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: (_cwd: string, _stack: unknown, service: string) => service === "db" && docker.dbRunning,
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
  runDockerCompose: (_path: string, args: string[]) => {
    docker.compose.push(args)
    if (args[0] === "up" && args.includes("db")) docker.dbRunning = true
    return 0
  },
}))
vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: () => ({ status: 0, stdout: JSON.stringify(DIFF), stderr: "", pid: 0, output: [], signal: null }),
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => ({ version: 2, models: [] }),
}))
const engine = vi.hoisted(() => ({ fail: false }))
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => undefined,
  engineRequest: async () => {
    if (engine.fail) throw new Error("engine refused")
    return DIFF
  },
}))

const DIFF = vi.hoisted(() => ({ operations: [], warnings: [] }))

const { diffSchemaDocker } = await import("../src/dev-compose.js")

const base: SupatypeProjectConfig = {
  project: { name: "acme" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}
const engines: Array<[string, SupatypeProjectConfig]> = [
  ["the schema-engine container", base],
  ["the host engine binary", { ...base, overrides: { engine: "/opt/supatype-engine" } }],
]

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-diff-db-"))
  writeFileSync(join(cwd, ".env"), "POSTGRES_PASSWORD=pw\nPOSTGRES_DB=acme\nSUPATYPE_DEV_DB_PORT=54777\nSUPATYPE_KONG_PORT=55560\n")
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  docker.compose.length = 0
  docker.dbRunning = false
  docker.healthFails = false
  engine.fail = false
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

const stops = () => docker.compose.filter((args) => args[0] === "stop")

describe.each(engines)("supatype diff through %s", (_label, config) => {
  it("stops the database it started", async () => {
    await diffSchemaDocker(cwd, config)
    expect(docker.compose).toContainEqual(["up", "-d", "db"])
    expect(stops()).toEqual([["stop", "db"]])
  })

  it("leaves running a database that was already running", async () => {
    docker.dbRunning = true
    await diffSchemaDocker(cwd, config)
    expect(stops()).toEqual([])
  })
})

describe("supatype diff when starting the database fails partway", () => {
  it("still stops the database it brought up", async () => {
    docker.healthFails = true
    await expect(diffSchemaDocker(cwd, engines[0]![1])).rejects.toThrow("docker exec failed")
    expect(docker.compose).toContainEqual(["up", "-d", "db"])
    expect(stops()).toEqual([["stop", "db"]])
  })
})

describe("supatype diff when the diff fails", () => {
  it("still stops the database it started", async () => {
    engine.fail = true
    await expect(diffSchemaDocker(cwd, engines[1]![1])).rejects.toThrow("engine refused")
    expect(stops()).toEqual([["stop", "db"]])
  })
})
