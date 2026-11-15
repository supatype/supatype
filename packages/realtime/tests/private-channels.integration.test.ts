import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { RealtimeServer } from "../src/server.js"
import { RlsFilter } from "../src/rls.js"
import type { WalChange } from "../src/types.js"
import { anonKey, connect, freePort, isSystem, settle, testEnv, userToken, type Peer } from "./fixtures/socket.js"

/**
 * Private channels against a real Postgres running the engine's own functions: the server's
 * questions answered by what a push of `fixtures/lot-channels.schema.json` (the design note's
 * LotChannel, Lobby and an Announcements channel with no send or track rule) installed, and the
 * outbox read back through a real logical replication slot.
 *
 * The in-memory tests prove what the server does with an answer. This proves the questions
 * themselves: that they run as the caller with the caller's claims, that a rule reading a table is
 * judged under that table's row security, that a topic which does not fit comes back as `fits =
 * false`, that content checks and dependencies come back in a shape the server reads, and that a
 * row `realtime_send` writes reaches the members of its channel.
 *
 * To run it: start the pinned supatype/postgres image with `wal_level=logical`, push the schema
 * with `supatype-engine push -i tests/fixtures/lot-channels.schema.json --database-url ...`, and
 * set `DATABASE_URL` to that database as a superuser. Skips without `DATABASE_URL`.
 */
const databaseUrl = process.env["DATABASE_URL"]

const ALICE = "11111111-1111-4111-8111-111111111111"
const SELLER = "33333333-3333-4333-8333-333333333333"
const EVE = "44444444-4444-4444-8444-444444444444"
const LOT = "8f14e45f-ceea-467a-9575-8b0e4a1b2c3d"
const TOPIC = `lot:${LOT}`
const SLOT = "g93_pc_integration"

/** Against a real database in a container the first questions are slow; a frame is waited for this long. */
const SLOW_DATABASE_MS = 8000

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lot-channels.schema.json")

describe.skipIf(!databaseUrl)("private channels against Postgres", { timeout: 30_000 }, () => {
  let admin: pg.Client
  let server: RealtimeServer
  let filter: RlsFilter
  let port: number
  const peers: Peer[] = []

  const open = async (token?: string): Promise<Peer> => {
    const peer = await connect(port, token)
    peers.push(peer)
    return peer
  }
  let refs = 0
  const join = async (peer: Peer, channel: string): Promise<ReturnType<Peer["next"]>> => {
    const ref = `pg-${++refs}`
    peer.send({ type: "subscribe", channel, ref })
    return peer.next((m) => m.type === "system" && m.ref === ref, SLOW_DATABASE_MS)
  }

  /** `realtime_send` called the way a function in the caller's session would, as `authenticated`. */
  const sendAs = async (sub: string, topic: string, event: string, payload: object): Promise<void> => {
    await admin.query("BEGIN")
    try {
      await admin.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: "authenticated" })])
      await admin.query("SET LOCAL ROLE authenticated")
      await admin.query("SELECT _supatype.realtime_send($1, $2, $3::jsonb)", [topic, event, JSON.stringify(payload)])
      await admin.query("COMMIT")
    } catch (err) {
      await admin.query("ROLLBACK")
      throw err
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const installed = await admin.query("SELECT to_regprocedure('_supatype.realtime_channel_access(text)') AS fn")
    if (installed.rows[0]?.fn === null) {
      throw new Error(`push ${schemaPath} to this database first: the channel functions are not installed`)
    }
    await admin.query("DELETE FROM public.lot_watchers")
    await admin.query("DELETE FROM public.lots")
    await admin.query("INSERT INTO public.lots (id, seller_id) VALUES ($1, $2)", [LOT, SELLER])
    await admin.query("INSERT INTO public.lot_watchers (lot_id, user_id) VALUES ($1, $2), ($1, $3)", [LOT, ALICE, SELLER])
    filter = new RlsFilter(databaseUrl!)
    port = await freePort()
    server = new RealtimeServer(
      testEnv(port, { databaseUrl: databaseUrl!, slotName: SLOT, replicationPollInterval: 100 }),
      { rlsFilter: filter },
    )
    await server.start()
    await server.waitForReplicationStartup()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server?.stop()
    await admin?.query("SELECT pg_drop_replication_slot($1) FROM pg_replication_slots WHERE slot_name = $1", [SLOT])
    await admin?.end()
  })

  it("refuses the anon key a declared channel and admits a watcher, as the caller", async () => {
    const anon = await open(anonKey())
    const alice = await open(userToken(ALICE))

    const refused = await join(anon, TOPIC)
    const admitted = await join(alice, TOPIC)

    // anon has no privilege on lot_watchers, so the rule raises; the function maps that to false.
    expect(refused).toMatchObject({
      status: "error",
      message: `not allowed to join ${TOPIC}: the join rule of LotChannel denied it`,
    })
    expect(admitted).toMatchObject({ status: "ok", message: `subscribed to ${TOPIC}` })
  })

  it("answers a topic that does not fit with fits = false, not a cast error", async () => {
    const alice = await open(userToken(ALICE))

    const answer = await join(alice, "lot:42")

    expect(answer).toMatchObject({ status: "error", message: "lot:42 does not fit lot:{id}: id must be a UUID" })
  })

  it("reads a NULL verdict from the database as a declaration with no rule for that operation", async () => {
    const alice = await open(userToken(ALICE))
    await join(alice, "announce")

    alice.send({ type: "broadcast", channel: "announce", event: "x", payload: {} })
    const refusal = await alice.next(isSystem("error", "declares no send rule"), SLOW_DATABASE_MS)

    expect(refusal).toMatchObject({
      message: "Announcements declares no send rule, so only the service role may broadcast on announce",
    })
  })

  it("judges a rule that reads a table under that table's own row security", async () => {
    // EVE is nobody's watcher, and the policy on lot_watchers lets a caller see only their own rows.
    const eve = await open(userToken(EVE))

    const answer = await join(eve, TOPIC)

    expect(answer).toMatchObject({ status: "error" })
  })

  it("lets only the seller broadcast, and holds the bid to the send rule's payload checks", async () => {
    const seller = await open(userToken(SELLER))
    const alice = await open(userToken(ALICE))
    await join(seller, TOPIC)
    await join(alice, TOPIC)

    alice.send({ type: "broadcast", channel: TOPIC, event: "bid", payload: { amount: 5 } })
    const watcherRefusal = await alice.next(isSystem("error", "not allowed to broadcast on"), SLOW_DATABASE_MS)
    seller.send({ type: "broadcast", channel: TOPIC, event: "bid", payload: { amount: 0 } })
    const lowRefusal = await seller.next(isSystem("error", "refused the payload"), SLOW_DATABASE_MS)
    seller.send({ type: "broadcast", channel: TOPIC, event: "bid", payload: { amount: 12 } })
    const heard = await alice.next((m) => m.type === "broadcast", SLOW_DATABASE_MS)

    expect(watcherRefusal).toMatchObject({ channel: TOPIC })
    expect(lowRefusal).toMatchObject({ channel: TOPIC })
    expect(heard).toMatchObject({ event: "bid", payload: { amount: 12 } })
  })

  it("delivers what realtime_send wrote, through the slot, to the admitted members only", async () => {
    const alice = await open(userToken(ALICE))
    const eve = await open(userToken(EVE))
    await join(alice, TOPIC)
    await join(eve, TOPIC)

    await sendAs(SELLER, TOPIC, "bid", { amount: 9 })
    const heard = await alice.next((m) => m.type === "broadcast", SLOW_DATABASE_MS)
    await settle(eve)

    expect(heard).toEqual({ type: "broadcast", channel: TOPIC, event: "bid", payload: { amount: 9 } })
    expect(eve.frames.some((m) => m.type === "broadcast")).toBe(false)
    expect(alice.frames.filter((m) => m.type === "change")).toEqual([])
  })

  it("lets realtime_send refuse a caller whose send rule says no, so nothing reaches the slot", async () => {
    await expect(sendAs(ALICE, TOPIC, "bid", { amount: 9 })).rejects.toMatchObject({ code: "42501" })
  })

  it("withdraws a channel when the watch row is deleted and the table's change arrives", async () => {
    const alice = await open(userToken(ALICE))
    await join(alice, TOPIC)

    await admin.query("DELETE FROM public.lot_watchers WHERE user_id = $1", [ALICE])
    const change: WalChange = {
      schema: "public",
      table: "lot_watchers",
      event: "DELETE",
      newRecord: null,
      oldRecord: { lot_id: LOT, user_id: ALICE },
      exactColumns: {},
      columnTypes: {},
      commitTimestamp: "2026-11-14T10:00:00+00:00",
    }
    await server.dispatchChange(change)
    const withdrawn = await alice.next(isSystem("error", "was withdrawn"), SLOW_DATABASE_MS)
    await settle(alice)

    expect(withdrawn).toMatchObject({ channel: TOPIC })
    await admin.query("INSERT INTO public.lot_watchers (lot_id, user_id) VALUES ($1, $2)", [LOT, ALICE])
  })
})
