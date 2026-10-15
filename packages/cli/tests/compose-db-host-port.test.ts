import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * M1: the compose file publishes Postgres in one of two places. A dev stack binds
 * `127.0.0.1:${SUPATYPE_DEV_DB_PORT:-54329}`, a production (standalone) stack binds
 * `${SUPATYPE_DB_PORT:-5432}`. Every host-side command read the dev port whatever the stack was, so
 * on a production stack `diff`, `adopt` and a push with `overrides.engine` connected to 54329: a
 * timeout with nothing there, or another project's dev database when one was.
 *
 * Each command below is asked for the URL it would use, against a dev stack and against a
 * production stack whose `.env` moves both ports, so a port read from the wrong variable shows.
 */

const DEV_PORT = 54777
const PROD_PORT = 6543

/**
 * What `docker` answers: whether the project's server container runs, and the mode it runs in.
 * `compose` counts the compose commands run, so a refusal can be shown to start nothing.
 */
const docker = vi.hoisted(() => ({ running: true, serverMode: "dev" as "dev" | "standalone", compose: 0 }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const fake = (command: string, args: readonly string[] = []) => {
    if (command !== "docker") return actual.spawnSync(command, [...args], { encoding: "utf8" })
    if (args[0] === "ps") return { status: 0, stdout: docker.running ? "c0ffee\n" : "", stderr: "" }
    if (args[0] === "inspect") return { status: 0, stdout: `SUPATYPE_MODE=${docker.serverMode}\n`, stderr: "" }
    return { status: 0, stdout: "", stderr: "" }
  }
  return { ...actual, spawnSync: fake }
})

vi.mock("../src/dev-ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-ports.js")>()),
  ensureKongPort: async () => 55560,
  ensureDevDbPort: async () => DEV_PORT,
}))

vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  writeSelfHostCompose: (cwd: string) => ({
    dir: join(cwd, ".supatype", "self-host"),
    composePath: join(cwd, ".supatype", "self-host", "docker-compose.yml"),
    kongPath: "",
    nginxPath: "",
    s3ConfigPath: "",
  }),
  runDockerCompose: () => {
    docker.compose += 1
    return 0
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

/** The URL each engine call was given. The push stops at the engine, which is all this asks. */
const engine = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => undefined,
  engineRequest: async (_endpoint: string, body: Record<string, unknown>) => {
    // Type generation and the admin config read only the AST; they name no database.
    if (body["database_url"] !== undefined) engine.urls.push(String(body["database_url"]))
    return {}
  },
  enginePush: async (_cwd: string, body: Record<string, unknown>) => {
    engine.urls.push(String(body["database_url"]))
    throw new Error("pushed")
  },
}))

const { adoptSchemaDocker, diffSchemaDocker, dockerDiff, pushSchemaDocker, resolveHostEngineDatabaseUrl } =
  await import("../src/dev-compose.js")
const { resolveHostDatabaseUrl } = await import("../src/host-database.js")
const { isProjectDatabase } = await import("../src/local-stack.js")

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  overrides: { engine: "/opt/supatype-engine" },
}

const ENV = [
  "POSTGRES_PASSWORD=pw",
  "POSTGRES_DB=acme",
  `SUPATYPE_DEV_DB_PORT=${DEV_PORT}`,
  `SUPATYPE_DB_PORT=${PROD_PORT}`,
  "SUPATYPE_KONG_PORT=55560",
  "",
].join("\n")

const urlAt = (port: number): string => `postgresql://supatype_admin:pw@127.0.0.1:${port}/acme?sslmode=disable`

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-db-host-port-"))
  writeFileSync(join(cwd, ".env"), ENV)
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  writeFileSync(join(cwd, ".supatype", "schema.ast.json"), JSON.stringify({ version: 2, models: [] }))
  engine.urls.length = 0
  docker.running = true
  docker.compose = 0
  for (const key of ["SUPATYPE_DEV_DB_PORT", "SUPATYPE_DB_PORT", "DATABASE_URL"]) delete process.env[key]
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env["DATABASE_URL"]
  rmSync(cwd, { recursive: true, force: true })
})

/** The single URL a command handed the engine. */
async function engineUrl(run: () => Promise<unknown>): Promise<string> {
  await run().catch((err: unknown) => {
    if (!(err instanceof Error) || err.message !== "pushed") throw err
  })
  expect(new Set(engine.urls).size).toBe(1)
  return engine.urls[0]!
}

const commands: Array<[string, () => Promise<unknown>]> = [
  ["diff (diffSchemaDocker)", () => diffSchemaDocker(cwd, config)],
  ["a refused push's diff (dockerDiff)", () => dockerDiff(cwd, config)],
  ["adopt (adoptSchemaDocker)", () => adoptSchemaDocker(cwd, config, false)],
  ["push with overrides.engine (pushSchemaDocker)", () => pushSchemaDocker(cwd, config)],
]

describe.each([
  ["a dev stack", "dev" as const, DEV_PORT],
  ["a production stack", "standalone" as const, PROD_PORT],
])("host-side commands on %s", (_label, mode, port) => {
  beforeEach(() => {
    docker.serverMode = mode
  })

  it.each(commands)("%s connects where compose publishes the database", async (_name, run) => {
    expect(await engineUrl(run)).toBe(urlAt(port))
  })

  it("seed, admin and the other resolver users derive the published database", () => {
    expect(resolveHostDatabaseUrl(cwd, config, { allowDerived: true }).dsn).toBe(urlAt(port))
  })

  it("push recognises the stack's own database by its published port", () => {
    expect(isProjectDatabase(cwd, config, urlAt(port))).toBe(true)
    expect(isProjectDatabase(cwd, config, urlAt(port === DEV_PORT ? PROD_PORT : DEV_PORT))).toBe(false)
  })
})

/**
 * M1b: with no stack running for the project (no `supatype dev` session, no server container), the
 * derived URL used to fall back to the production port, 5432 by default, which can be a host
 * Postgres that has nothing to do with this project. Every command that derives the database from
 * the stack now refuses instead, before starting anything. A URL someone named is still used.
 */
describe("host-side commands with no stack running", () => {
  const NO_STACK =
    "No stack is running for acme. Start it with `supatype dev` or `supatype self-host compose up -d`."

  beforeEach(() => {
    docker.running = false
  })

  it.each(commands)("%s refuses and starts nothing", async (_name, run) => {
    await expect(run()).rejects.toThrow(NO_STACK)
    expect(engine.urls).toEqual([])
    expect(docker.compose).toBe(0)
  })

  it("seed, admin and the other resolver users refuse to derive a database", () => {
    expect(() => resolveHostDatabaseUrl(cwd, config, { allowDerived: true })).toThrow(NO_STACK)
  })

  it("pull and a direct target with the host engine refuse and start nothing", async () => {
    await expect(resolveHostEngineDatabaseUrl(cwd, config)).rejects.toThrow(NO_STACK)
    expect(docker.compose).toBe(0)
  })

  const NAMED = "postgresql://someone:pw@db.example.com:5432/acme"

  it("a DATABASE_URL someone set is used as it is", () => {
    process.env["DATABASE_URL"] = NAMED
    expect(resolveHostDatabaseUrl(cwd, config, { allowDerived: true }).dsn).toBe(NAMED)
  })

  it("--connection is used as it is", () => {
    expect(resolveHostDatabaseUrl(cwd, config, { connection: NAMED, allowDerived: true }).dsn).toBe(NAMED)
  })

  it("the host engine uses a DATABASE_URL someone set without starting the stack's database", async () => {
    process.env["DATABASE_URL"] = NAMED
    expect(await resolveHostEngineDatabaseUrl(cwd, config)).toBe(NAMED)
    expect(docker.compose).toBe(0)
  })
})
