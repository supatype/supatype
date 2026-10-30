import { describe, expect, it } from "vitest"
import { nativeRolesSql } from "../src/native-roles-sql.js"

/**
 * The server no longer writes a database-level search_path, so a native cluster has to give the
 * `postgres` role the path the image gives it (supatype-postgres, init-scripts/00000000000003-post-setup.sql:
 * `ALTER ROLE postgres SET search_path TO "$user",public,extensions;`), or an extension's types in
 * `extensions` (vector, for one) are not found by name. Only when the role has no path of its own,
 * so one an operator set is kept; other roles keep Postgres's default.
 */
describe("native setup and the postgres role's search_path", () => {
  const sql = nativeRolesSql(false)

  it("sets the image's path on the postgres role", () => {
    expect(sql).toContain('ALTER ROLE postgres SET search_path TO "$user",public,extensions;')
  })

  it("only when the role has no role-level search_path yet", () => {
    expect(sql).toMatch(
      /IF NOT EXISTS \(\s*SELECT FROM pg_db_role_setting s, unnest\(s\.setconfig\) AS c\s+WHERE s\.setdatabase = 0 AND s\.setrole = 'postgres'::regrole AND c LIKE 'search_path=%'\s*\)\s*THEN\s+ALTER ROLE postgres SET search_path/,
    )
  })

  it("sets no path on any other role", () => {
    expect(sql.match(/ALTER ROLE \w+ SET search_path/g)).toEqual(["ALTER ROLE postgres SET search_path"])
  })
})
