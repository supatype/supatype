import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import {
  CLI_MEMBERSHIP_SOURCE,
  recordStudioMembership,
  setStudioRole,
} from "../src/commands/admin.js"

// Studio flags a membership change made around it: the engine's audit trigger
// records the transaction's `supatype.membership_api` setting as the change's
// source, and only `on` (the membership API), `cli` and `seed` are trusted. So
// every membership write the CLI makes has to carry `cli` in the statement that
// writes, or an admin made with `supatype admin create-user` shows as changed
// outside Studio the moment it exists.

interface Recorded {
  sql: string
  params: unknown[]
}

function recordingQuery(): { query: (sql: string, params?: unknown[]) => Promise<{ rows: [] }>; log: Recorded[] } {
  const log: Recorded[] = []
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: [] }> => {
    log.push({ sql, params })
    return { rows: [] }
  }
  return { query, log }
}

const MARK = `set_config('supatype.membership_api', '${CLI_MEMBERSHIP_SOURCE}', true)`

/** The statements in `log` that write `studio_members`. */
function membershipWrites(log: Recorded[]): Recorded[] {
  return log.filter((entry) => /INSERT INTO _supatype\.studio_members/.test(entry.sql))
}

describe("the CLI's membership writes", () => {
  it("are marked as the CLI's, by name", () => {
    expect(CLI_MEMBERSHIP_SOURCE).toBe("cli")
  })

  it("mark create-user's grant in the statement that writes it", async () => {
    const { query, log } = recordingQuery()
    await recordStudioMembership(query, "11111111-2222-3333-4444-555555555555", "admin")
    const writes = membershipWrites(log)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.sql).toContain(MARK)
  })

  it("mark set-role's change in the statement that writes it", async () => {
    const { query, log } = recordingQuery()
    await setStudioRole(query, "someone@example.com", "editor")
    const writes = membershipWrites(log)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.sql).toContain(MARK)
  })
})

const dsn = process.env.SUPATYPE_TEST_DSN

/** The membership tables, one user, and a trigger capturing the setting each write sees. */
const SETUP = `
  CREATE SCHEMA IF NOT EXISTS _supatype;
  CREATE SCHEMA IF NOT EXISTS auth;
  DROP TABLE IF EXISTS _supatype.studio_members, _supatype.cli_source_capture, auth.users;
  CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
  INSERT INTO auth.users VALUES ('11111111-2222-3333-4444-555555555555', 'someone@example.com');
  CREATE TABLE _supatype.cli_source_capture (id BIGSERIAL PRIMARY KEY, source TEXT);
  CREATE OR REPLACE FUNCTION _supatype.capture_cli_source() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO _supatype.cli_source_capture (source)
    VALUES (nullif(current_setting('supatype.membership_api', true), ''));
    RETURN NULL;
  END $$;`

const TRIGGER = `
  CREATE TRIGGER capture_cli_source AFTER INSERT OR UPDATE ON _supatype.studio_members
    FOR EACH ROW EXECUTE FUNCTION _supatype.capture_cli_source();`

describe.skipIf(!dsn)("the CLI's membership writes against Postgres", () => {
  const pool = new pg.Pool({ connectionString: dsn, max: 1 })
  const query = async (sql: string, params?: unknown[]) => ({
    rows: (await pool.query<Record<string, unknown>>(sql, params)).rows,
  })

  beforeAll(async () => {
    await pool.query(SETUP)
  })
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS _supatype.studio_members, _supatype.cli_source_capture, auth.users")
    await pool.end()
  })

  it("reach the audit trigger as the CLI's, and a raw change after them does not", async () => {
    await recordStudioMembership(query, "11111111-2222-3333-4444-555555555555", "viewer")
    await pool.query(TRIGGER)
    await recordStudioMembership(query, "11111111-2222-3333-4444-555555555555", "admin")
    await setStudioRole(query, "someone@example.com", "editor")
    await pool.query("UPDATE _supatype.studio_members SET role = 'viewer' WHERE role = 'editor'")
    const captured = await pool.query<{ source: string | null }>("SELECT source FROM _supatype.cli_source_capture ORDER BY id")
    expect(captured.rows.map((row) => row.source)).toEqual(["cli", "cli", null])
  })
})
