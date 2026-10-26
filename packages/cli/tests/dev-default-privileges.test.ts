import { describe, expect, it, vi } from "vitest"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * CL-N2: local `supatype dev` made every new table in `public` readable by `anon` (and writable by
 * `authenticated`) through default privileges, so a table made by hand in dev was open, unlike
 * Cloud after CL1. Default privileges on tables now go to `service_role` only; a model table's
 * grants are the engine's, written from the schema's access rules.
 */

interface SpawnOptions { input?: string }
const spawnSync = vi.fn<(cmd: string, args: readonly string[], opts: SpawnOptions) => Partial<SpawnSyncReturns<string>>>(
  () => ({ status: 0, stdout: "", stderr: "" }),
)
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[], opts: SpawnOptions) => spawnSync(cmd, args, opts),
}))

const { nativeRolesSql, PRIVATE_TABLE_DEFAULTS_SQL } = await import("../src/native-roles-sql.js")
const { privatizeTableDefaults } = await import("../src/compose-db-roles.js")

/** Statements that hand `anon` or `authenticated` tables, now or by default. */
const OPEN_TABLE_GRANT = /GRANT [^;]*ON (?:ALL )?TABLES[^;]*TO [^;]*\b(?:anon|authenticated)\b/i

describe("native dev's roles script", () => {
  for (const withMask of [false, true]) {
    it(`gives tables to service_role only (${withMask ? "with" : "without"} the mask)`, () => {
      const sql = nativeRolesSql(withMask)
      expect(sql).not.toMatch(OPEN_TABLE_GRANT)
      expect(sql).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;")
      // A database set up by an earlier CLI loses the open defaults it was given.
      expect(sql).toContain(PRIVATE_TABLE_DEFAULTS_SQL)
    })
  }
})

describe("the docker dev database", () => {
  it("revokes anon's and authenticated's table defaults for every role that has some in public", () => {
    expect(PRIVATE_TABLE_DEFAULTS_SQL).toMatch(/REVOKE ALL ON TABLES FROM anon, authenticated/)
    expect(PRIVATE_TABLE_DEFAULTS_SQL).toContain("pg_default_acl")
    expect(PRIVATE_TABLE_DEFAULTS_SQL).not.toMatch(OPEN_TABLE_GRANT)
  })

  it("runs that inside the db container as the bundled superuser", () => {
    privatizeTableDefaults({ composePath: "/p/.supatype/self-host/docker-compose.yml" }, process.cwd(), "supatype-acme")
    const [cmd, args, opts] = spawnSync.mock.calls.at(-1) ?? []
    expect(cmd).toBe("docker")
    expect(args).toEqual(expect.arrayContaining(["exec", "-T", "db", "psql"]))
    expect(opts?.input).toBe(PRIVATE_TABLE_DEFAULTS_SQL)
  })
})
