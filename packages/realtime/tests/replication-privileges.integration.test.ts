import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { ReplicationListener } from "../src/replication.js"
import type { WalChange } from "../src/types.js"

/**
 * What privilege realtime actually needs.
 *
 * The listener used to run `CREATE PUBLICATION … FOR ALL TABLES` at startup, which requires
 * **superuser** — a privilege managed Postgres (RDS, Cloud SQL and friends) does not grant. It was
 * the single biggest obstacle to running realtime against a database Supatype does not own, and it
 * did nothing: `wal2json` decodes from the replication slot, publications are a `pgoutput` concept,
 * and nothing read `pg_publication` after creating it.
 *
 * So this asserts the claim directly, as a **non-superuser** role: the slot is created, changes
 * decode, and no publication appears. Without it, "we removed a superuser requirement" is an
 * assertion about code rather than a fact about behaviour.
 *
 * Needs `DATABASE_URL` for a database with `wal2json` and `wal_level=logical`. Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const ROLE = "rt_replicator"
const ROLE_PASSWORD = "rt-replicator-password"
const SLOT = "rt_privilege_probe_slot"
const TABLE = "rt_privilege_probe"

/** The same connection, as the unprivileged replication role. */
function asRole(url: string): string {
  const parsed = new URL(url)
  parsed.username = ROLE
  parsed.password = ROLE_PASSWORD
  return parsed.toString()
}

describe.skipIf(!databaseUrl)("replication privileges", () => {
  let admin: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()

    // A role that can create a replication slot but is *not* a superuser — the shape a managed
    // provider gives you.
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          CREATE ROLE ${ROLE} LOGIN REPLICATION PASSWORD '${ROLE_PASSWORD}';
        ELSE
          ALTER ROLE ${ROLE} LOGIN REPLICATION PASSWORD '${ROLE_PASSWORD}';
        END IF;
      END $$;
    `)
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`)
    await admin.query(`CREATE TABLE public.${TABLE} (id int primary key, note text)`)
    await admin.query(`GRANT SELECT, INSERT ON public.${TABLE} TO ${ROLE}`)
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    await admin
      .query(`SELECT pg_drop_replication_slot($1)`, [SLOT])
      .catch(() => undefined /* not there yet */)
    await admin.query(`DROP PUBLICATION IF EXISTS supatype_realtime_pub`)
  })

  afterAll(async () => {
    await admin.query(`SELECT pg_drop_replication_slot($1)`, [SLOT]).catch(() => undefined)
    await admin.query(`DROP TABLE IF EXISTS public.${TABLE}`)
    await admin.end()
  })

  it("decodes changes as a non-superuser, and creates no publication", async () => {
    const isSuper: boolean = (
      await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = $1`, [ROLE])
    ).rows[0].rolsuper
    expect(isSuper, "the probe role must not be a superuser, or this proves nothing").toBe(false)

    const changes: WalChange[] = []
    const listener = new ReplicationListener({
      databaseUrl: asRole(databaseUrl!),
      slotName: SLOT,
      pollInterval: 200,
    })
    listener.onChange((c) => changes.push(c))

    // The assertion that matters: this used to need superuser and now must not.
    await listener.start()

    try {
      const slots = await admin.query(`SELECT plugin FROM pg_replication_slots WHERE slot_name = $1`, [SLOT])
      expect(slots.rows.length, "the non-superuser role should have created the slot").toBe(1)
      expect(slots.rows[0].plugin).toBe("wal2json")

      // No publication — the thing that required superuser must not have been recreated.
      const pubs = await admin.query(`SELECT pubname FROM pg_publication WHERE pubname = 'supatype_realtime_pub'`)
      expect(pubs.rows.length, "startup created a publication again; that reintroduces the superuser requirement").toBe(0)

      await admin.query(`INSERT INTO public.${TABLE} VALUES (1, 'decoded without a publication')`)

      // Wait for *this* table. The slot decodes the whole database, so a sibling integration test
      // running concurrently will put its own changes through first — waiting for "any change"
      // makes this pass or fail on test ordering.
      const mine = () => changes.find((c) => c.table === TABLE && c.event === "INSERT")
      const deadline = Date.now() + 15_000
      while (!mine() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }

      const insert = mine()
      expect(insert, `expected an INSERT on ${TABLE}, got ${JSON.stringify(changes)}`).toBeDefined()
      expect(insert?.newRecord?.["note"]).toBe("decoded without a publication")
    } finally {
      await listener.stop()
    }
  }, 30_000)
})
