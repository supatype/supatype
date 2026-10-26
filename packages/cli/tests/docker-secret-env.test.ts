import { beforeEach, describe, expect, it, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * A secret the CLI hands to `docker` or to the engine goes in the child's environment, never on its
 * command line. Any local user can read a process's command line while it runs, and a sampler
 * caught `-e PGPASSWORD=...`, `-e SUPATYPE_AUTHENTICATOR_PASSWORD=...` and
 * `--database-url postgresql://user:password@...` there during `supatype dev`.
 */

const SECRET = "s3cret-value-xyz"

interface SpawnOptions { env?: NodeJS.ProcessEnv }
type Spawned = Partial<SpawnSyncReturns<string>>
const spawnSync = vi.fn<(cmd: string, args: readonly string[], opts?: SpawnOptions) => Spawned>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[], opts?: SpawnOptions) => spawnSync(cmd, args, opts),
}))
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }))
vi.mock("../src/ensure-binary.js", () => ({ ensureBinary: async () => "/fake/supatype-engine" }))

const { dockerEnv } = await import("../src/docker-env.js")
const { dockerPgStart, runAuthMigrationsViaDocker } = await import("../src/docker-postgres.js")
const { engineRequest } = await import("../src/engine-client.js")
const { spawnComposeEngine } = await import("../src/compose-engine-run.js")
const { splitPassword } = await import("../src/host-database.js")
const { AUTHENTICATOR_PASSWORD_ENV, nativeRolesSql } = await import("../src/native-roles-sql.js")

/** The one spawn made, with the secret nowhere on its command line. */
function onlyCall(): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  expect(spawnSync).toHaveBeenCalledTimes(1)
  const [, args, opts] = spawnSync.mock.calls[0]!
  expect(args.join(" ")).not.toContain(SECRET)
  return { args, env: opts?.env ?? {} }
}

/** The names passed as bare `-e NAME`. */
function bareEnvFlags(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []))
}

beforeEach(() => {
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" })
})

describe("dockerEnv", () => {
  it("names each variable on the command line and puts its value in the environment", () => {
    const { args, env } = dockerEnv({ PGPASSWORD: SECRET, OTHER: "x" }, { PATH: "/bin" })

    expect(args).toEqual(["-e", "PGPASSWORD", "-e", "OTHER"])
    expect(env).toEqual({ PATH: "/bin", PGPASSWORD: SECRET, OTHER: "x" })
  })

  it("overrides a value the caller's environment already had", () => {
    expect(dockerEnv({ PGPASSWORD: SECRET }, { PGPASSWORD: "stale" }).env["PGPASSWORD"]).toBe(SECRET)
  })
})

describe("docker run for the dev Postgres", () => {
  it("passes POSTGRES_PASSWORD through the environment", () => {
    dockerPgStart({ image: "supatype/postgres:test", projectName: "p", port: 5555, password: SECRET })
    // The first call removes any old container; the second is the run.
    const [, args, opts] = spawnSync.mock.calls[1]!

    expect(args.join(" ")).not.toContain(SECRET)
    expect(bareEnvFlags(args)).toContain("POSTGRES_PASSWORD")
    expect(opts?.env?.["POSTGRES_PASSWORD"]).toBe(SECRET)
  })

  it("passes the auth migration's settings through the environment", () => {
    runAuthMigrationsViaDocker("pg", "supatype/server:test", {
      DATABASE_URL: `postgres://supatype_admin:${SECRET}@127.0.0.1:5432/p`,
      JWT_SECRET: SECRET,
    })
    const { args, env } = onlyCall()

    expect(bareEnvFlags(args)).toEqual(["DATABASE_URL", "JWT_SECRET"])
    expect(env["JWT_SECRET"]).toBe(SECRET)
  })
})

describe("the engine", () => {
  it.each(["/diff", "/push", "/seed", "/introspect", "/doctor", "/adopt", "/rollback", "/migrations"])(
    "%s gets the database URL from DATABASE_URL, not --database-url",
    async (endpoint) => {
      spawnSync.mockReturnValue({ status: 0, stdout: "{}", stderr: "" })
      const url = `postgresql://supatype_admin:${SECRET}@127.0.0.1:54329/app`

      await engineRequest(endpoint, { ast: { models: [] }, database_url: url })
      const { args, env } = onlyCall()

      expect(args).not.toContain("--database-url")
      expect(env["DATABASE_URL"]).toBe(url)
    },
  )

  it("in the compose tools profile gets the database URL through a bare -e DATABASE_URL", () => {
    const url = `postgresql://supatype_admin:${SECRET}@db:5432/app`
    const target = { cwd: ".", project: "p", composePath: "compose.yml", engineImage: "supatype/engine:test" }

    spawnComposeEngine(target, ["diff", "--schema", "public"], { secrets: { DATABASE_URL: url } })
    const { args, env } = onlyCall()

    expect(bareEnvFlags(args)).toEqual(["DATABASE_URL"])
    expect(args.indexOf("DATABASE_URL")).toBeLessThan(args.indexOf("schema-engine"))
    expect(env["DATABASE_URL"]).toBe(url)
    expect(env["SUPATYPE_ENGINE_IMAGE"]).toBe("supatype/engine:test")
  })
})

describe("a connection string for pg_dump", () => {
  it("loses its password to the environment", () => {
    expect(splitPassword(`postgresql://supatype_admin:${SECRET}%40x@db:5432/app`)).toEqual({
      dsn: "postgresql://supatype_admin@db:5432/app",
      password: `${SECRET}@x`,
    })
  })

  it("is left alone when it has no password", () => {
    expect(splitPassword("postgresql://supatype_admin@db/app")).toEqual({
      dsn: "postgresql://supatype_admin@db/app",
      password: undefined,
    })
  })
})

describe("native dev's role script", () => {
  it("reads the authenticator password from the environment, never from its own text", () => {
    const sql = nativeRolesSql(false)

    expect(sql).toContain(`\\getenv authenticator_password ${AUTHENTICATOR_PASSWORD_ENV}`)
    expect(sql).not.toMatch(/PASSWORD '/)
  })
})

/**
 * Every place that builds a docker or engine command line, not only the ones above: no `-e` with
 * an inline value, and no `--database-url`, anywhere in the CLI's source.
 */
describe("the CLI source", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src")
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : []
    })
  // Read once for every check below. Comments may name what the code must not do.
  const isComment = (line: string): boolean => /^(\/\/|\/\*|\*)/.test(line)
  const lines = files(srcDir).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((line, i) => ({ where: `${path}:${i + 1}`, line: line.trim() }))
      .filter(({ line }) => !isComment(line)),
  )
  const offenders = (pattern: RegExp): string[] =>
    lines.filter(({ line }) => pattern.test(line)).map(({ where, line }) => `${where}: ${line}`)

  it("never puts a value on docker's command line with -e", () => {
    // `"-e", `NAME=${value}`` on one line or two, the `["-e", `${k}=${v}`]` map, and a literal
    // `"-e", "NAME=value"`, which hardcodes a value where the project's own belongs.
    const inline = /^\s*`[A-Z_][A-Z0-9_]*=\$\{|"-e",\s*`[^`]*=\$\{|"-e",\s*["'][A-Z_][A-Z0-9_]*=/
    expect(offenders(inline)).toEqual([])
  })

  it("never passes --database-url on a command line", () => {
    // Quoted any way, and with `=value` joined on.
    expect(offenders(/["'`]--database-url/)).toEqual([])
  })
})
