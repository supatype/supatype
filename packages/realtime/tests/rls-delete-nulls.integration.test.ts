import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { RlsFilter } from "../src/rls.js"
import { parseWal2json, SLOT_READ_QUERY } from "../src/replication.js"
import type { JwtClaims } from "../src/auth.js"
import type { WalChange } from "../src/types.js"
import { ownedTable, PREAMBLE, readPredicate, unreadableColumn } from "./fixtures/owned-table.js"

/**
 * A DELETE of a row with NULL columns, decoded by wal2json from a real slot (TEST-1-N2).
 *
 * Under `REPLICA IDENTITY FULL`, wal2json's old keys leave every NULL column out rather than
 * sending it as null: a row `(id, owner, title, NULL, NULL)` arrives with three keys. Realtime used
 * to read any absent column as "the WAL carries only the key" and withheld the event, so the DELETE
 * of most rows was never delivered.
 *
 * Needs `DATABASE_URL` for a database with `wal2json`, `wal_level=logical` and `supatype_mask`.
 * Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const SLOT = "rt_delete_nulls_slot"

/** Each table and the replica identity it starts with. */
const TABLES = { rt_null_full: "FULL", rt_null_default: "DEFAULT", rt_null_later: "DEFAULT" } as const

/** An owner-only table with a column nobody may read, and one row each for alice and bob. */
function nullableTable(name: string, identity: string): string {
  return `
    ${ownedTable(name, "id text PRIMARY KEY, owner text, title text, body text, secret text", `ALTER TABLE ${name} REPLICA IDENTITY ${identity};`)}
    ${readPredicate(name)}
    ${unreadableColumn(name, "secret")}
    INSERT INTO ${name} (id, owner, title) VALUES ('${name}-alice', 'alice', 'a'), ('${name}-bob', 'bob', 'b');`
}

const SETUP = `${PREAMBLE}
  ${Object.entries(TABLES).map(([name, identity]) => nullableTable(name, identity)).join("\n")}`

/** Alice's row as it was, NULL columns included and the unreadable one masked. */
const alicesRow = (table: string): Record<string, unknown> => ({
  id: `${table}-alice`, owner: "alice", title: "a", body: null, secret: null,
})

describe.skipIf(!databaseUrl)("DELETE of a row with NULL columns (TEST-1-N2)", () => {
  let admin: pg.Client
  let filter: RlsFilter

  const alice = { sub: "alice", role: "authenticated" } as JwtClaims

  /** Delete one row and return its DELETE exactly as the slot decodes it. */
  async function deleteThroughSlot(table: string, id: string): Promise<WalChange> {
    await admin.query(`DELETE FROM public.${table} WHERE id = $1`, [id])
    const rows = await admin.query<{ data: string }>(SLOT_READ_QUERY, [SLOT])
    const changes = rows.rows.flatMap((row) => parseWal2json(row.data))
    const change = changes.find((c) => c.table === table && c.event === "DELETE")
    if (!change) throw new Error(`no DELETE on ${table} in ${JSON.stringify(changes)}`)
    return change
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`SELECT pg_drop_replication_slot($1)`, [SLOT]).catch(() => undefined)
    await admin.query(SETUP)
    await admin.query(`SELECT pg_create_logical_replication_slot($1, 'wal2json')`, [SLOT])
    filter = new RlsFilter(databaseUrl!)
  })

  afterAll(async () => {
    await filter?.shutdown()
    await admin?.query(`SELECT pg_drop_replication_slot($1)`, [SLOT]).catch(() => undefined)
    await admin?.query(Object.keys(TABLES).map((t) => `DROP TABLE IF EXISTS public.${t} CASCADE;`).join("\n"))
    await admin?.end()
  })

  it("delivers the owner's DELETE whole and masked, though wal2json left the NULL columns out", async () => {
    const change = await deleteThroughSlot("rt_null_full", "rt_null_full-alice")
    expect(Object.keys(change.oldRecord ?? {}).sort(), "the shape this guards").toEqual(["id", "owner", "title"])
    expect((await filter.visibleChange(alice, change))?.oldRecord).toEqual(alicesRow("rt_null_full"))
  })

  it("withholds a stranger's DELETE of a row with NULL columns", async () => {
    const change = await deleteThroughSlot("rt_null_full", "rt_null_full-bob")
    expect(await filter.visibleChange(alice, change)).toBeNull()
  })

  it("still fails closed on a table without REPLICA IDENTITY FULL", async () => {
    const change = await deleteThroughSlot("rt_null_default", "rt_null_default-alice")
    expect(Object.keys(change.oldRecord ?? {})).toEqual(["id"])
    expect(await filter.visibleChange(alice, change)).toBeNull()
  })

  it("reads the replica identity again once a push invalidates the catalog", async () => {
    const before = await deleteThroughSlot("rt_null_later", "rt_null_later-bob")
    expect(await filter.visibleChange(alice, before)).toBeNull()

    await admin.query(`ALTER TABLE public.rt_null_later REPLICA IDENTITY FULL`)
    filter.invalidateCatalogs()
    const after = await deleteThroughSlot("rt_null_later", "rt_null_later-alice")
    expect((await filter.visibleChange(alice, after))?.oldRecord).toEqual(alicesRow("rt_null_later"))
  })
})
