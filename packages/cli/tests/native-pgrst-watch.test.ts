import { describe, expect, it } from "vitest"
import { nativeRolesSql } from "../src/native-roles-sql.js"

/**
 * Local test round 3b N13: a model added while native dev ran was invisible to REST (PGRST205)
 * until PostgREST reloaded. The image installs PostgREST's schema-cache event triggers
 * (supatype-postgres, 20220126121436_finer-postgrest-triggers.sql and its ALTER TYPE fix); a native
 * cluster had none. The setup script, run on every start, installs the same ones.
 */
describe("native setup and PostgREST's schema cache", () => {
  const sql = nativeRolesSql(false)

  it("installs the image's DDL and drop watches as event triggers, replacing any earlier ones", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger")
    expect(sql).toContain("CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger")
    expect(sql).toMatch(/DROP EVENT TRIGGER IF EXISTS pgrst_ddl_watch;\s+CREATE EVENT TRIGGER pgrst_ddl_watch\s+ON ddl_command_end/)
    expect(sql).toMatch(/DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;\s+CREATE EVENT TRIGGER pgrst_drop_watch\s+ON sql_drop/)
  })

  it("reloads on the commands the image's fixed trigger watches, ALTER TYPE included", () => {
    expect(sql).toContain("'CREATE TYPE', 'ALTER TYPE'")
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';")
  })
})
