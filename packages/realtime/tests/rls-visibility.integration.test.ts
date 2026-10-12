import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { RlsFilter } from "../src/rls.js"
import type { JwtClaims } from "../src/auth.js"
import type { LogLevel } from "../src/env.js"
import type { WalChange } from "../src/types.js"
import { ownedTable, PREAMBLE, readPredicate, unreadableColumn } from "./fixtures/owned-table.js"
import { captureConsole } from "./fixtures/console.js"

/**
 * Row visibility against a real database (H3: M06 and P03).
 *
 * - The primary key comes from the catalog, composite keys included. It used to be `id`, or else
 *   the first column, so a stranger's row sharing that column's value was delivered whole.
 * - A DELETE reaches a subscriber only if they could have seen the old row, judged with the
 *   generated `can_read_<table>` on the WAL's old tuple. It used to reach every role holding
 *   SELECT on the table.
 *
 * Needs `DATABASE_URL` pointing at a database with `supatype_mask` available. Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const SETUP = `
  ${PREAMBLE}
  ${ownedTable("rt_ticket", "category text, code text PRIMARY KEY, owner text, label text")}
  INSERT INTO rt_ticket VALUES ('shared', 'T-mine', 'alice', 'own'), ('shared', 'T-theirs', 'bob', 'stranger');
  ${ownedTable("rt_pair", "a int, b int, owner text, PRIMARY KEY (a, b)")}
  INSERT INTO rt_pair VALUES (1, 1, 'alice'), (1, 2, 'bob');
  ${ownedTable("rt_nokey", "label text, owner text")}
  INSERT INTO rt_nokey VALUES ('x', 'alice');
  ${ownedTable("rt_note", "id text PRIMARY KEY, owner text, body text, secret text", "ALTER TABLE rt_note REPLICA IDENTITY FULL;")}
  ${readPredicate("rt_note")}
  ${unreadableColumn("rt_note", "secret")}
  ${ownedTable("rt_plain", "id text PRIMARY KEY, owner text")}
  ${readPredicate("rt_plain")}
  ${ownedTable("rt_nopred", "id text PRIMARY KEY, owner text", "ALTER TABLE rt_nopred REPLICA IDENTITY FULL;")}
`

const TABLES = ["rt_ticket", "rt_pair", "rt_nokey", "rt_note", "rt_plain", "rt_nopred"]

describe.skipIf(!databaseUrl)("RlsFilter row visibility", () => {
  let admin: pg.Client
  let filter: RlsFilter

  const alice = { sub: "alice", role: "authenticated" } as JwtClaims
  const bobs = { id: "n-bob", owner: "bob", body: "bob-private-body", secret: "s-bob" }
  const alices = { id: "n-alice", owner: "alice", body: "alice-body", secret: "s-alice" }

  const insert = (table: string, row: Record<string, unknown>): WalChange => ({
    schema: "public",
    table,
    event: "INSERT",
    newRecord: row,
    oldRecord: null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
  })
  const remove = (table: string, old: Record<string, unknown>): WalChange => ({
    ...insert(table, {}),
    event: "DELETE",
    newRecord: null,
    oldRecord: old,
  })

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(SETUP)
    filter = new RlsFilter(databaseUrl!)
  })

  afterAll(async () => {
    await filter?.shutdown()
    await admin?.query(TABLES.map((t) => `DROP TABLE IF EXISTS ${t} CASCADE;`).join("\n"))
    await admin?.end()
  })

  describe("primary key from the catalog (M06)", () => {
    it("withholds a stranger's row that shares the first column with a visible one", async () => {
      const theirs = { category: "shared", code: "T-theirs", owner: "bob", label: "stranger" }
      expect(await filter.visibleChange(alice, insert("rt_ticket", theirs))).toBeNull()
    })

    it("still delivers the subscriber's own row", async () => {
      const mine = { category: "shared", code: "T-mine", owner: "alice", label: "own" }
      expect((await filter.visibleChange(alice, insert("rt_ticket", mine)))?.newRecord).toEqual(mine)
    })

    it("matches every column of a composite key", async () => {
      expect(await filter.visibleChange(alice, insert("rt_pair", { a: 1, b: 2, owner: "bob" }))).toBeNull()
      expect(await filter.visibleChange(alice, insert("rt_pair", { a: 1, b: 1, owner: "alice" }))).not.toBeNull()
    })

    it("fails closed on a table with no primary key", async () => {
      expect(await filter.visibleChange(alice, insert("rt_nokey", { label: "x", owner: "bob" }))).toBeNull()
    })
  })

  describe("DELETE judged on the old row (P03)", () => {
    it("withholds the delete of a row the subscriber could not see", async () => {
      expect(await filter.visibleChange(alice, remove("rt_note", bobs))).toBeNull()
    })

    it("delivers the delete of the subscriber's own row, with field rules applied", async () => {
      const visible = await filter.visibleChange(alice, remove("rt_note", alices))
      expect(visible?.oldRecord).toEqual({ ...alices, secret: null })
    })

    it("fails closed when the old tuple carries only the key", async () => {
      expect(await filter.visibleChange(alice, remove("rt_plain", { id: "p-1" }))).toBeNull()
    })

    it("fails closed when the table has no read predicate", async () => {
      expect(await filter.visibleChange(alice, remove("rt_nopred", { id: "x", owner: "alice" }))).toBeNull()
    })

    it("still sends every delete to service_role", async () => {
      const service = { sub: "svc", role: "service_role" } as JwtClaims
      expect((await filter.visibleChange(service, remove("rt_note", bobs)))?.oldRecord).toEqual(bobs)
    })
  })

  describe("drop logging (T2-N9, R2)", () => {
    /** Every line logged while judging a denied DELETE and a failed one, at `level`. */
    async function dropLines(level: LogLevel): Promise<string[]> {
      const captured = captureConsole()
      const judge = new RlsFilter(databaseUrl!, level)
      try {
        await judge.visibleChange(alice, remove("rt_note", bobs))
        await judge.visibleChange(alice, remove("rt_plain", { id: "p-secret-key" }))
      } finally {
        await judge.shutdown()
        captured.restore()
      }
      const lines = captured.calls.map((call) => call.args.map(String).join(" "))
      for (const line of lines) {
        expect(line).not.toMatch(/bob-private-body|s-bob|p-secret-key/)
      }
      return lines
    }

    it("logs table, operation, role and reason, and no value from the row, at debug", async () => {
      const lines = await dropLines("debug")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("dropped DELETE on public.rt_note for role authenticated")
      expect(lines[1]).toContain("REPLICA IDENTITY FULL")
    })

    it("logs only the failure at info, not the subscriber the rules turned away", async () => {
      const lines = await dropLines("info")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("dropped DELETE on public.rt_plain")
      expect(lines[0]).toContain("REPLICA IDENTITY FULL")
    })
  })
})
