import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { ReplicationListener, committedBefore, lsnValue } from "../src/replication.js"
import { RlsFilter } from "../src/rls.js"
import type { WalChange } from "../src/types.js"

/**
 * The WAL positions a join is placed against, read from a real slot (0.9.2 release test N-S5).
 *
 * What `committedBefore` relies on, asserted rather than assumed: wal2json format 1 gives one slot
 * row per transaction whose `lsn` is where its commit ends, so a transaction that was still open
 * when a join read its position counts as after the join, even for the rows it wrote before.
 *
 * Needs `DATABASE_URL` for a database with `wal2json` and `wal_level=logical`. Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const SLOT = "rt_join_position_slot"
const TABLE = "rt_join_position"

describe.skipIf(!databaseUrl)("join positions against a real slot", () => {
  let admin: pg.Client
  let filter: RlsFilter
  let listener: ReplicationListener
  const changes: WalChange[] = []

  /** The WAL position now, read the way a join reads it. */
  const position = async (): Promise<bigint | undefined> => {
    const text = await filter.walPosition()
    return (text === null ? null : lsnValue(text)) ?? undefined
  }

  const decoded = async (id: string): Promise<WalChange> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const found = changes.find((c) => c.table === TABLE && c.newRecord?.["id"] === id)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`no change decoded for ${id}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`)
    await admin.query(`CREATE TABLE public.${TABLE} (id text PRIMARY KEY)`)
    await admin.query(`SELECT pg_drop_replication_slot($1)`, [SLOT]).catch(() => undefined)
    filter = new RlsFilter(databaseUrl!)
    listener = new ReplicationListener({ databaseUrl: databaseUrl!, slotName: SLOT, pollInterval: 100 })
    listener.onChange((c) => changes.push(c))
    await listener.start()
  })

  afterAll(async () => {
    await listener?.stop()
    await filter?.shutdown()
    await admin.query(`SELECT pg_drop_replication_slot($1)`, [SLOT]).catch(() => undefined)
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`)
    await admin.end()
  })

  it("places a commit before a position read after it, and after one read before it", async () => {
    const before = await position()
    await admin.query(`INSERT INTO public.${TABLE} VALUES ('one')`)
    const after = await position()
    const one = await decoded("one")

    expect(typeof one.commitLsn).toBe("bigint")
    expect(before).toBeTypeOf("bigint")
    expect(committedBefore(one, before)).toBe(false)
    expect(committedBefore(one, after)).toBe(true)
  }, 30_000)

  it("counts a transaction still open when the position was read as after it", async () => {
    const writer = new pg.Client({ connectionString: databaseUrl })
    await writer.connect()
    try {
      await writer.query("BEGIN")
      await writer.query(`INSERT INTO public.${TABLE} VALUES ('early')`)
      const joined = await position()
      await writer.query(`INSERT INTO public.${TABLE} VALUES ('late')`)
      await writer.query("COMMIT")

      const early = await decoded("early")
      const late = await decoded("late")
      expect(early.commitLsn).toBe(late.commitLsn)
      expect(committedBefore(early, joined)).toBe(false)
      expect(committedBefore(late, joined)).toBe(false)
    } finally {
      await writer.end()
    }
  }, 30_000)
})
