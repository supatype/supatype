import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import pg from "pg"
import { RlsFilter } from "../src/rls.js"
import type { WalChange } from "../src/types.js"
import type { JwtClaims } from "../src/auth.js"

/**
 * Field masking against a real database.
 *
 * The unit tests cover which columns get nulled; this covers the part that can only be
 * wrong against Postgres: building the table's composite type from a WAL record and
 * evaluating the generated predicate against it, as the subscriber, in one transaction.
 *
 * Needs `DATABASE_URL` pointing at a database with `supatype_mask` available. Skips
 * otherwise so the unit suite stays runnable anywhere.
 */
const databaseUrl = process.env["DATABASE_URL"]

describe.skipIf(!databaseUrl)("RlsFilter field masking", () => {
  let admin: pg.Client
  let filter: RlsFilter

  const change = (over: Partial<WalChange> = {}): WalChange => ({
    schema: "public",
    table: "rt_posts",
    event: "INSERT",
    newRecord: { id: 1, title: "hello", salary: 100, author_id: "alice" },
    oldRecord: null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
    ...over,
  })

  const claimsFor = (sub: string): JwtClaims => ({ sub, role: "authenticated" })

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query("CREATE EXTENSION IF NOT EXISTS supatype_mask")
    await admin.query(`
      DROP TABLE IF EXISTS rt_posts CASCADE;
      CREATE TABLE rt_posts (id int primary key, title text, salary numeric, author_id text);
      ALTER TABLE rt_posts REPLICA IDENTITY FULL;
      INSERT INTO rt_posts VALUES (1, 'hello', 100, 'alice');
      CREATE OR REPLACE FUNCTION can_read_rt_posts(rt_posts rt_posts)
        RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true FROM (SELECT ($1).*) AS rt_posts; $$;
      CREATE OR REPLACE FUNCTION can_read_rt_posts__salary(rt_posts rt_posts)
        RETURNS boolean LANGUAGE sql STABLE AS $$
          SELECT author_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'
            FROM (SELECT ($1).*) AS rt_posts;
        $$;
      SECURITY LABEL FOR supatype ON COLUMN rt_posts.salary
        IS 'MASK READ public."can_read_rt_posts__salary"';
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END $$;
      GRANT SELECT ON rt_posts TO authenticated;
    `)
    filter = new RlsFilter(databaseUrl!)
  })

  afterAll(async () => {
    await filter?.shutdown()
    await admin?.query("DROP TABLE IF EXISTS rt_posts CASCADE")
    await admin?.end()
  })

  // The value passes through from the WAL record untouched -- it is never re-read from the
  // table, which is what makes this race-free and what keeps a number a number.
  it("sends the real value to the owner", async () => {
    const visible = await filter.visibleChange(claimsFor("alice"), change())
    expect(visible?.newRecord?.["salary"]).toBe(100)
  })

  it("nulls the column for a subscriber who fails the rule", async () => {
    const visible = await filter.visibleChange(claimsFor("bob"), change())
    expect(visible).not.toBeNull()
    expect(visible?.newRecord?.["salary"]).toBeNull()
    // Only the restricted column is affected.
    expect(visible?.newRecord?.["title"]).toBe("hello")
  })

  // The old and new rows are judged separately. An update that moves ownership flips the
  // verdict between them, and the old value is the one worth protecting.
  it("judges the old row on its own terms", async () => {
    const visible = await filter.visibleChange(
      claimsFor("alice"),
      change({
        event: "UPDATE",
        newRecord: { id: 1, title: "hello", salary: 200, author_id: "bob" },
        oldRecord: { id: 1, title: "hello", salary: 100, author_id: "alice" },
      }),
    )
    expect(visible?.newRecord?.["salary"]).toBeNull() // now bob's
    expect(visible?.oldRecord?.["salary"]).toBe(100) // was alice's
  })

  // Under REPLICA IDENTITY FULL a DELETE carries the whole old row, restricted columns
  // included, and there is no row left to re-read: the old tuple is both judged and masked.
  it("masks the old row of a delete whose row no longer exists", async () => {
    await admin.query("DELETE FROM rt_posts WHERE id = 1")
    const old = { id: 1, title: "hello", salary: 100, author_id: "alice" }
    const deleted = change({ event: "DELETE", newRecord: null, oldRecord: old })
    try {
      const own = await filter.visibleChange(claimsFor("alice"), deleted)
      expect(own?.oldRecord).toEqual(old)
      const other = await filter.visibleChange(claimsFor("bob"), deleted)
      expect(other?.oldRecord).toEqual({ ...old, salary: null })
    } finally {
      await admin.query("INSERT INTO rt_posts VALUES (1, 'hello', 100, 'alice')")
    }
  })

  it("exempts service_role, matching the extension", async () => {
    const visible = await filter.visibleChange(
      { sub: "nobody", role: "service_role" },
      change(),
    )
    expect(visible?.newRecord?.["salary"]).toBe(100)
  })

  it("drops the event for an unauthenticated subscriber", async () => {
    expect(await filter.visibleChange(null, change())).toBeNull()
  })

  // Fail closed: if the predicate cannot be evaluated the event is dropped rather than
  // sent with the column in the clear.
  it("drops the event when the predicate is missing", async () => {
    await admin.query(
      `SECURITY LABEL FOR supatype ON COLUMN rt_posts.salary IS 'MASK READ public."no_such_predicate"'`,
    )
    filter.invalidateCatalogs()
    try {
      expect(await filter.visibleChange(claimsFor("alice"), change())).toBeNull()
    } finally {
      await admin.query(
        `SECURITY LABEL FOR supatype ON COLUMN rt_posts.salary IS 'MASK READ public."can_read_rt_posts__salary"'`,
      )
      filter.invalidateCatalogs()
    }
  })

  // What the inspector is told about one delivery: the masked change plus which columns were
  // masked, so Studio can say "redacted" rather than show a null nobody stored.
  it("reports which columns it masked for a delivery", async () => {
    const verdict = await filter.judgeForDelivery(claimsFor("bob"), change())
    if (!("send" in verdict)) throw new Error("expected the change to be sent")
    expect(verdict.send.newRecord?.["salary"]).toBeNull()
    expect(verdict.redacted.new).toContain("salary")
    expect(verdict.redacted.old).toEqual([])

    const own = await filter.judgeForDelivery(claimsFor("alice"), change())
    if (!("send" in own)) throw new Error("expected the change to be sent")
    expect(own.redacted.new).toEqual([])
  })

  it("names the refusal instead of returning nothing", async () => {
    const verdict = await filter.judgeForDelivery(null, change())
    expect(verdict).toMatchObject({ refused: { severity: "denied" } })
  })

  // Judging a change as the Studio viewer withholds nothing from anybody, so it must not write a
  // drop line: the log would then report drops that never happened.
  it("judges as an inspector's viewer without logging a drop", async () => {
    const warn = vi.spyOn(console, "warn")
    const debug = vi.spyOn(console, "debug")
    try {
      const hidden = await filter.inspectAs(claimsFor("bob"), change({ newRecord: { id: 999, title: "x", salary: 1, author_id: "bob" } }))
      expect(hidden).toMatchObject({ refused: { severity: "denied" } })
      const seen = await filter.inspectAs(claimsFor("bob"), change())
      if (!("send" in seen)) throw new Error("expected the change to be visible")
      expect(seen.redacted.new).toContain("salary")
      expect(warn).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      debug.mockRestore()
    }
  })
})
