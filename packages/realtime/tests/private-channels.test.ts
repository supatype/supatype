import { afterEach, describe, expect, it, vi } from "vitest"
import jwt from "jsonwebtoken"
import { RealtimeServer } from "../src/server.js"
import type { WalChange, ServerMessage } from "../src/types.js"
import type { RealtimeEnv } from "../src/env.js"
import {
  SECRET,
  anonKey,
  connect,
  freePort,
  isSystem,
  serviceToken,
  settle,
  testEnv,
  userToken,
  type Peer,
} from "./fixtures/socket.js"
import { FakeChannelDb, LOT_ID, OTHER_LOT_ID } from "./fixtures/fake-channel-db.js"

/**
 * Private channels: what the realtime server does with a join, a broadcast and a presence track
 * on a channel the schema declares (plan section 9, "Realtime server").
 *
 * Today any holder of the anon key can join `lot:<id>`, hear every bid broadcast on it, broadcast
 * a fake bid and appear in its presence. These run the real server over real sockets, against an
 * in-memory copy of the engine's channel functions, and they were run red against the server as it
 * was before this change.
 */

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const SELLER = "33333333-3333-4333-8333-333333333333"
const EVE = "44444444-4444-4444-8444-444444444444"

const LOT = `lot:${LOT_ID}`

function auctioneerToken(): string {
  return jwt.sign({ sub: EVE, role: "authenticated", app_metadata: { role: "auctioneer" } }, SECRET, { expiresIn: 600 })
}

interface Harness {
  server: RealtimeServer
  db: FakeChannelDb
  open: (token?: string) => Promise<Peer>
}

const running: Array<{ server: RealtimeServer; peers: Peer[] }> = []

/**
 * A server on a fake database. `configure` runs before the server starts: the project's mode and
 * its content checks are read once at start and after a push, so a test sets them first.
 */
async function harness(over: Partial<RealtimeEnv> = {}, configure: (db: FakeChannelDb) => void = () => {}): Promise<Harness> {
  const db = new FakeChannelDb()
  configure(db)
  db.watch(LOT_ID, ALICE)
  db.watch(LOT_ID, BOB)
  db.watch(LOT_ID, SELLER)
  db.sellers.set(LOT_ID, SELLER)
  const port = await freePort()
  const server = new RealtimeServer(testEnv(port, over), { channelDb: db })
  await server.start()
  const peers: Peer[] = []
  running.push({ server, peers })
  const open = async (token?: string): Promise<Peer> => {
    const peer = await connect(port, token)
    peers.push(peer)
    return peer
  }
  return { server, db, open }
}

afterEach(async () => {
  for (const { server, peers } of running.splice(0)) {
    for (const peer of peers) peer.close()
    await server.stop()
  }
})

let refCounter = 0

/** Send a join and return the server's answer to it: the acceptance, or the error naming the channel. */
async function join(peer: Peer, channel: string, extra: Record<string, unknown> = {}): Promise<ServerMessage> {
  const ref = `join-${++refCounter}`
  peer.send({ type: "subscribe", channel, ref, ...extra })
  return peer.next((m) => m.type === "system" && m.ref === ref)
}

const refusalOf = (peer: Peer, channel: string): ServerMessage | undefined =>
  peer.frames.find((m) => m.type === "system" && m.status === "error" && m.channel === channel)

const relayed = (peer: Peer): ServerMessage[] => peer.frames.filter((m) => m.type === "broadcast" || m.type === "presence")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function change(schema: string, table: string, event: WalChange["event"], row: Record<string, unknown>): WalChange {
  return {
    schema,
    table,
    event,
    newRecord: event === "DELETE" ? null : row,
    oldRecord: event === "INSERT" ? null : row,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: "2026-11-14T10:00:00+00:00",
  }
}

describe("an anon-key socket on a declared channel (the Gavel finding)", () => {
  it("cannot join it, and says why", async () => {
    const { open } = await harness()
    const anon = await open(anonKey())

    await join(anon, LOT)

    expect(refusalOf(anon, LOT)).toMatchObject({
      code: "join_denied",
      message: `not allowed to join ${LOT}: the join rule of LotChannel denied it`,
    })
  })

  it("cannot broadcast on it, and a member hears nothing", async () => {
    const { open } = await harness()
    const member = await open(userToken(ALICE))
    await join(member, LOT)
    const anon = await open(anonKey())
    await join(anon, LOT)

    anon.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 9999 } })
    await settle(anon)
    await settle(member)

    expect(relayed(member)).toEqual([])
  })

  it("cannot appear in its presence", async () => {
    const { open } = await harness()
    const member = await open(userToken(ALICE))
    await join(member, LOT)
    const anon = await open(anonKey())
    await join(anon, LOT)

    anon.send({ type: "presence_track", channel: LOT, payload: { status: "here" } })
    await settle(anon)
    await settle(member)

    expect(relayed(member)).toEqual([])
  })

  it("is refused as a denial, not as an unreachable database, when the rule reads a table anon cannot see", async () => {
    const { open, db } = await harness()
    db.anonLacksPrivilege = true
    const anon = await open(anonKey())

    await join(anon, LOT)

    expect(refusalOf(anon, LOT)).toMatchObject({
      message: `not allowed to join ${LOT}: the join rule of this channel's declaration denied it`,
    })
  })

  it("is refused a topic that does not fit the pattern, naming the declaration", async () => {
    const { open } = await harness()
    const member = await open(userToken(ALICE))

    await join(member, "lot:42")

    expect(refusalOf(member, "lot:42")).toMatchObject({ code: "does_not_fit", message: "lot:42 does not fit lot:{id}: id must be a UUID" })
  })

  it("is refused a channel name over 255 characters before the database is asked anything", async () => {
    const { open, db } = await harness()
    const member = await open(userToken(ALICE))
    const long = `lot:${"a".repeat(300)}`
    const before = db.callerSessions + db.serviceSessions

    await join(member, long)

    expect(refusalOf(member, long)).toMatchObject({ code: "refused", message: "channel name is too long: 304 characters, the limit is 255" })
    expect(db.callerSessions + db.serviceSessions).toBe(before)
    const ok = `lot:${"a".repeat(251)}`
    expect(await join(member, ok)).toMatchObject({ status: "error", message: expect.not.stringContaining("too long") })
  })

  it("says so when a declaration has no rule for the operation, and a rule that said no is worded differently", async () => {
    const { open } = await harness()
    const member = await open(userToken(ALICE))
    await join(member, "announce")

    member.send({ type: "broadcast", channel: "announce", event: "x", payload: {} })
    const send = await member.next(isSystem("error", "declares no send rule"))
    member.send({ type: "presence_track", channel: "announce", payload: {} })
    const track = await member.next(isSystem("error", "declares no track rule"))

    expect(send).toMatchObject({ code: "send_denied", message: "Announcements declares no send rule, so only the service role may broadcast on announce" })
    expect(track).toMatchObject({ code: "track_denied", message: "Announcements declares no track rule, so only the service role may track presence on announce" })
  })
})

describe("a signed-in user on a declared channel", () => {
  it("joins when the join rule admits them, and is refused when it does not", async () => {
    const { open } = await harness()
    const watcher = await open(userToken(ALICE))
    const stranger = await open(userToken(EVE))

    const admitted = await join(watcher, LOT)
    await join(stranger, LOT)

    expect(admitted).toMatchObject({ status: "ok", message: `subscribed to ${LOT}` })
    expect(refusalOf(stranger, LOT)).toBeDefined()
    expect(refusalOf(watcher, LOT)).toBeUndefined()
  })

  it("may broadcast only when the send rule admits them", async () => {
    const { open } = await harness()
    const seller = await open(userToken(SELLER))
    const watcher = await open(userToken(ALICE))
    await join(seller, LOT)
    await join(watcher, LOT)

    watcher.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    const refusal = await watcher.next(isSystem("error", "not allowed to broadcast"))
    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    const heard = await watcher.next((m) => m.type === "broadcast")

    expect(refusal).toMatchObject({
      channel: LOT,
      code: "send_denied",
      message: `not allowed to broadcast on ${LOT}: the send rule of LotChannel denied it`,
    })
    expect(heard).toEqual({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await settle(seller)
    expect(relayed(seller)).toEqual([])
  })

  it("may track presence only when the track rule admits them", async () => {
    const { open, db } = await harness()
    db.watchers.get(LOT_ID)?.delete(BOB)
    const auctioneer = await open(auctioneerToken())
    const watcher = await open(userToken(ALICE))
    await join(auctioneer, LOT)
    await join(watcher, LOT)

    auctioneer.send({ type: "presence_track", channel: LOT, payload: {} })
    const refusal = await auctioneer.next(isSystem("error", "not allowed to track presence"))
    watcher.send({ type: "presence_track", channel: LOT, payload: { status: "here" } })
    const joined = await auctioneer.next((m) => m.type === "presence")

    expect(refusal).toMatchObject({
      code: "track_denied",
      message: `not allowed to track presence on ${LOT}: the track rule of LotChannel denied it`,
    })
    expect(joined.type === "presence" && joined.joins).toEqual([{ user_id: ALICE, status: "here" }])
  })

  it("is judged by the channel they name, not by another's: a different lot is a different answer", async () => {
    const { open } = await harness()
    const watcher = await open(userToken(ALICE))

    await join(watcher, `lot:${OTHER_LOT_ID}`)

    expect(refusalOf(watcher, `lot:${OTHER_LOT_ID}`)).toBeDefined()
  })
})

describe("what a join and a broadcast cost the database", () => {
  it("is one session per join and none for any broadcast or presence frame after it", async () => {
    const { open, db } = await harness()
    const seller = await open(userToken(SELLER))
    const watcher = await open(userToken(ALICE))

    await join(seller, LOT)
    await join(watcher, LOT)
    const afterJoins = { sessions: db.callerSessions, queries: db.queries, asked: db.accessCalls.length }
    for (let amount = 1; amount <= 5; amount++) {
      seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount } })
    }
    watcher.send({ type: "presence_track", channel: LOT, payload: {} })
    watcher.send({ type: "presence_untrack", channel: LOT })
    await settle(seller)
    await settle(watcher)

    expect(afterJoins.sessions).toBe(2)
    expect(afterJoins.asked).toBe(2)
    expect({ sessions: db.callerSessions, queries: db.queries, asked: db.accessCalls.length }).toEqual(afterJoins)
    expect(watcher.frames.filter((m) => m.type === "broadcast")).toHaveLength(5)
  })

  it("asks as the caller, with the caller's own claims", async () => {
    const { open, db } = await harness()
    const watcher = await open(userToken(ALICE))
    const anon = await open(anonKey())

    await join(watcher, LOT)
    await join(anon, LOT)

    expect(db.accessCalls).toEqual([
      { topic: LOT, sub: ALICE, role: "authenticated" },
      { topic: LOT, sub: undefined, role: "anon" },
    ])
  })

  it("is no session at all for the service role, which may do anything", async () => {
    const { open, db } = await harness()
    const service = await open(serviceToken())
    const watcher = await open(userToken(ALICE))
    await join(watcher, LOT)
    const before = db.callerSessions

    await join(service, LOT)
    service.send({ type: "broadcast", channel: LOT, event: "anything", payload: { free: true } })
    service.send({ type: "presence_track", channel: LOT, payload: {} })
    const heard = await watcher.next((m) => m.type === "broadcast")

    expect(heard).toMatchObject({ event: "anything" })
    expect(db.callerSessions).toBe(before)
    expect(refusalOf(service, LOT)).toBeUndefined()
  })
})

describe("a database that does not answer", () => {
  it("refuses the join instead of admitting it, and the socket holds no membership", async () => {
    const { open, db } = await harness()
    const member = await open(userToken(ALICE))
    const watcher = await open(userToken(BOB))
    await join(watcher, LOT)
    db.fault = new Error("connection refused")

    await join(member, LOT)
    member.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await member.next(isSystem("error", `subscribe to ${LOT} before broadcasting`))

    expect(refusalOf(member, LOT)).toMatchObject({
      code: "unavailable",
      message: `could not check access to ${LOT} because the database did not answer; retry`,
    })
    await settle(watcher)
    expect(relayed(watcher)).toEqual([])
  })

  it("admits the join once the database answers again", async () => {
    const { open, db } = await harness()
    const member = await open(userToken(ALICE))
    db.fault = new Error("connection refused")
    await join(member, LOT)
    db.fault = null

    const retried = await join(member, LOT)

    expect(retried).toMatchObject({ status: "ok", message: `subscribed to ${LOT}` })
  })
})

describe("presence on a channel the caller was refused", () => {
  it("is never sent to a denied joiner: not the state, and not what happens after", async () => {
    const { open } = await harness()
    const member = await open(userToken(ALICE))
    await join(member, LOT)
    member.send({ type: "presence_track", channel: LOT, payload: { status: "here" } })
    await member.next((m) => m.type === "presence")

    const anon = await open(anonKey())
    await join(anon, LOT)
    const other = await open(userToken(BOB))
    await join(other, LOT)
    other.send({ type: "presence_track", channel: LOT, payload: {} })
    await member.next((m) => m.type === "presence" && m.joins.some((j) => j.user_id === BOB))
    await settle(anon)

    expect(anon.frames.filter((m) => m.type === "presence")).toEqual([])
  })
})

describe("access that was taken away", () => {
  it("removes the channel when a new token no longer admits the user, and tells the others they left", async () => {
    const { open } = await harness()
    const alice = await open(userToken(ALICE))
    const bob = await open(userToken(BOB))
    await join(alice, LOT)
    await join(bob, LOT)
    alice.send({ type: "presence_track", channel: LOT, payload: { status: "here" } })
    await bob.next((m) => m.type === "presence" && m.joins.length === 1)

    alice.send({ type: "auth", token: userToken(EVE) })
    const withdrawn = await alice.next(isSystem("error", "was withdrawn"))
    const left = await bob.next((m) => m.type === "presence" && m.leaves.length === 1)

    expect(withdrawn).toMatchObject({
      channel: LOT,
      code: "withdrawn",
      message: `access to ${LOT} was withdrawn: the join rule of LotChannel no longer admits this user`,
    })
    expect(left.type === "presence" && left.leaves).toEqual([{ user_id: ALICE, status: "here" }])
    alice.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await alice.next(isSystem("error", `subscribe to ${LOT} before broadcasting`))
  })

  it("withdraws a channel joined with the service role when the new token is a user it does not admit", async () => {
    const { open } = await harness()
    const peer = await open(serviceToken())
    await join(peer, LOT)

    peer.send({ type: "auth", token: userToken(EVE) })
    const withdrawn = await peer.next(isSystem("error", "was withdrawn"), 3000)

    expect(withdrawn).toMatchObject({ channel: LOT })
    peer.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await peer.next(isSystem("error", `subscribe to ${LOT} before broadcasting`))
  })

  it("keeps the channel when the new token still admits the user", async () => {
    const { open } = await harness()
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)

    alice.send({ type: "auth", token: userToken(ALICE) })
    await alice.next((m) => isSystem("ok", "authenticated")(m) && alice.frames.filter(isSystem("ok", "authenticated")).length >= 2)
    await settle(alice)

    expect(refusalOf(alice, LOT)).toBeUndefined()
  })

  it("takes presence back when a new token loses only the track rule, and keeps the channel", async () => {
    const { open } = await harness()
    const alice = await open(userToken(ALICE))
    const bob = await open(userToken(BOB))
    await join(alice, LOT)
    await join(bob, LOT)
    alice.send({ type: "presence_track", channel: LOT, payload: { status: "here" } })
    await bob.next((m) => m.type === "presence" && m.joins.length === 1)

    alice.send({ type: "auth", token: auctioneerToken() })
    const left = await bob.next((m) => m.type === "presence" && m.leaves.length === 1)
    await settle(alice)
    alice.send({ type: "presence_track", channel: LOT, payload: {} })
    const refusal = await alice.next(isSystem("error", "not allowed to track presence"))

    expect(left.type === "presence" && left.leaves).toEqual([{ user_id: ALICE, status: "here" }])
    expect(refusal).toMatchObject({ channel: LOT })
    expect(alice.frames.some(isSystem("error", "was withdrawn"))).toBe(false)
  })

  it("fails closed on a token change when the database cannot be asked", async () => {
    const { open, db } = await harness()
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)
    db.fault = new Error("connection refused")

    alice.send({ type: "auth", token: userToken(ALICE) })
    const withdrawn = await alice.next(isSystem("error", `could not check access to ${LOT}`))

    expect(withdrawn).toMatchObject({ channel: LOT, code: "unavailable" })
    db.fault = null
    alice.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await alice.next(isSystem("error", `subscribe to ${LOT} before broadcasting`))
  })

  it("refuses a rejoin the user is no longer admitted to, and drops the old membership", async () => {
    const { open, db } = await harness()
    const alice = await open(userToken(ALICE))
    const seller = await open(userToken(SELLER))
    await join(alice, LOT)
    await join(seller, LOT)
    db.unwatch(LOT_ID, ALICE)

    const answer = await join(alice, LOT)
    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 5 } })
    await settle(seller)
    await settle(alice)

    expect(answer).toMatchObject({ status: "error", channel: LOT })
    expect(relayed(alice)).toEqual([])
  })

  it("is re-checked on a timer, so a user removed from the table loses the channel without a new token", async () => {
    const { open, db } = await harness({ channelRecheckSeconds: 1 })
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)

    db.unwatch(LOT_ID, ALICE)
    const withdrawn = await alice.next(isSystem("error", "was withdrawn"), 4000)

    expect(withdrawn).toMatchObject({ channel: LOT })
  })

  it("is re-checked when a table its rules read changes, within about a second", async () => {
    const { open, db, server } = await harness({ channelRecheckSeconds: 3600 })
    const alice = await open(userToken(ALICE))
    const bob = await open(userToken(BOB))
    await join(alice, LOT)
    await join(bob, LOT)
    db.unwatch(LOT_ID, ALICE)

    await server.dispatchChange(change("public", "lot_watchers", "DELETE", { lot_id: LOT_ID, user_id: ALICE }))
    const withdrawn = await alice.next(isSystem("error", "was withdrawn"), 3000)

    expect(withdrawn).toMatchObject({ channel: LOT })
    expect(refusalOf(bob, LOT)).toBeUndefined()
  })

  it("batches changes to the tables its rules read into one re-check a second, and ignores other tables", async () => {
    const { open, db, server } = await harness({ channelRecheckSeconds: 3600 })
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)
    const before = db.callerSessions

    await server.dispatchChange(change("public", "unrelated", "INSERT", { id: 1 }))
    await sleep(1300)
    expect(db.callerSessions).toBe(before)

    for (let i = 0; i < 20; i++) {
      await server.dispatchChange(change("public", "lot_watchers", "INSERT", { lot_id: LOT_ID, user_id: BOB }))
    }
    await sleep(1600)
    expect(db.callerSessions).toBe(before + 1)
  })
})

describe("the content of a broadcast", () => {
  it("is checked against the send rule's event and payload checks, with no database call", async () => {
    const { open, db } = await harness()
    const seller = await open(userToken(SELLER))
    const watcher = await open(userToken(ALICE))
    await join(seller, LOT)
    await join(watcher, LOT)
    const before = db.queries

    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 0 } })
    const lowRefusal = await seller.next(isSystem("error", "refused the payload"))
    seller.send({ type: "broadcast", channel: LOT, event: "chat", payload: { amount: 5 } })
    await seller.next((m) => isSystem("error", "refused the payload")(m) && seller.frames.filter(isSystem("error")).length >= 2)
    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: {} })
    await seller.next((m) => isSystem("error", "refused the payload")(m) && seller.frames.filter(isSystem("error")).length >= 3)
    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 7 } })
    const heard = await watcher.next((m) => m.type === "broadcast")

    expect(lowRefusal).toMatchObject({
      channel: LOT,
      code: "payload_refused",
      message: `not allowed to broadcast bid on ${LOT}: the send rule of LotChannel refused the payload`,
    })
    expect(heard).toMatchObject({ event: "bid", payload: { amount: 7 } })
    expect(watcher.frames.filter((m) => m.type === "broadcast")).toHaveLength(1)
    expect(db.queries).toBe(before)
  })

  it("is refused outright when the checks cannot be read, rather than waved through", async () => {
    const { open } = await harness({}, (db) => {
      db.sendChecks = { type: "unheard-of" }
    })
    const seller = await open(userToken(SELLER))
    await join(seller, LOT)

    seller.send({ type: "broadcast", channel: LOT, event: "bid", payload: { amount: 7 } })

    await seller.next(isSystem("error", "refused the payload"))
  })
})

describe("the switch", () => {
  it("in declared mode refuses broadcast and presence on a channel nothing declares, and admits the join", async () => {
    const { open } = await harness()
    const peer = await open(userToken(ALICE))
    const listener = await open(userToken(BOB))
    await join(peer, "lobby-2")
    await join(listener, "lobby-2")

    peer.send({ type: "broadcast", channel: "lobby-2", event: "hi", payload: {} })
    const refusal = await peer.next(isSystem("error", "matches no declared channel"))
    peer.send({ type: "presence_track", channel: "lobby-2", payload: {} })
    await peer.next((m) => isSystem("error", "matches no declared channel")(m) && peer.frames.filter(isSystem("error")).length >= 2)

    expect(refusal).toMatchObject({
      message:
        'lobby-2 matches no declared channel, and this project refuses broadcast and presence on undeclared channels (realtime.channels is "declared")',
    })
    await settle(listener)
    expect(relayed(listener)).toEqual([])
  })

  it("in declared mode admits a join that listens for rows, which the table's own rules guard", async () => {
    const { open } = await harness()
    const peer = await open(userToken(ALICE))

    const answer = await join(peer, "orders", { table: "orders", changes: true })

    expect(answer).toMatchObject({ status: "ok", message: "subscribed to orders" })
  })

  it("in open mode leaves an undeclared channel as it was: anyone signed in may broadcast and track", async () => {
    const { open } = await harness({}, (db) => {
      db.mode = "open"
    })
    const peer = await open(userToken(ALICE))
    const listener = await open(userToken(BOB))
    await join(peer, "lobby-2")
    await join(listener, "lobby-2")

    peer.send({ type: "broadcast", channel: "lobby-2", event: "hi", payload: {} })
    const heard = await listener.next((m) => m.type === "broadcast")

    expect(heard).toMatchObject({ event: "hi" })
  })

  it("reads the mode again at the timed re-check, so a change the push watcher missed still takes effect", async () => {
    const { open, db } = await harness({ channelRecheckSeconds: 1 }, (fake) => {
      fake.mode = "open"
    })
    const peer = await open(userToken(ALICE))
    await join(peer, "lobby-2")
    db.mode = "declared"

    await sleep(1600)
    peer.send({ type: "broadcast", channel: "lobby-2", event: "hi", payload: {} })
    const refusal = await peer.next(isSystem("error", "matches no declared channel"), 3000)

    expect(refusal).toMatchObject({ channel: "lobby-2" })
  })

  it("enforces channels the first push declared, even when the server started before the functions existed", async () => {
    const { open, db } = await harness({ channelRecheckSeconds: 1 }, (fake) => {
      fake.noFunctions = true
    })
    const anon = await open(anonKey())
    await join(anon, LOT)
    db.noFunctions = false

    const withdrawn = await anon.next(isSystem("error", "was withdrawn"), 4000)

    expect(withdrawn).toMatchObject({ channel: LOT })
  })

  it("in open mode still enforces a channel that is declared", async () => {
    const { open } = await harness({}, (db) => {
      db.mode = "open"
    })
    const anon = await open(anonKey())

    await join(anon, LOT)

    expect(refusalOf(anon, LOT)).toBeDefined()
  })

  it("is tightened by REALTIME_CHANNELS, which can never loosen the database's own mode", async () => {
    const tight = await harness({ channels: "declared" }, (db) => {
      db.mode = "open"
    })
    const a = await tight.open(userToken(ALICE))
    await join(a, "lobby-2")
    a.send({ type: "broadcast", channel: "lobby-2", event: "hi", payload: {} })
    await a.next(isSystem("error", "matches no declared channel"))

    const loose = await harness({ channels: "open" })
    const b = await loose.open(userToken(ALICE))
    await join(b, "lobby-2")
    b.send({ type: "broadcast", channel: "lobby-2", event: "hi", payload: {} })
    await b.next(isSystem("error", "matches no declared channel"))
  })

  it("refuses a join opened as private when no declaration matches it", async () => {
    const { open } = await harness()
    const peer = await open(userToken(ALICE))

    await join(peer, "lot-42", { private: true })

    expect(refusalOf(peer, "lot-42")).toMatchObject({
      message: "lot-42 was opened as private, but no Channel declaration matches it",
    })
  })

  it("leaves everything as it was on a project whose engine has none of the functions", async () => {
    const { open, db } = await harness({}, (fake) => {
      fake.noFunctions = true
    })
    const a = await open(userToken(ALICE))
    const b = await open(userToken(BOB))
    await join(a, "room-1")
    await join(b, "room-1")

    a.send({ type: "broadcast", channel: "room-1", event: "hi", payload: {} })

    expect(await b.next((m) => m.type === "broadcast")).toMatchObject({ event: "hi" })
    expect(db.callerSessions).toBe(0)
  })
})

describe("the capability announcement", () => {
  it("is on the first system frame a socket receives", async () => {
    const { open } = await harness()
    const anon = await open(anonKey())
    const bare = await open()

    expect(anon.frames[0] ?? (await anon.next(isSystem("ok")))).toMatchObject({ type: "system", features: ["private_channels"] })
    expect(bare.frames[0] ?? (await bare.next(isSystem("ok")))).toMatchObject({ type: "system", features: ["private_channels"] })
  })
})

describe("a broadcast sent from the database", () => {
  const outbox = (topic: string, event: string, payload: unknown): WalChange =>
    change("_supatype", "realtime_outbox", "INSERT", { id: "1", topic, event, payload, sender: ALICE })

  it("reaches the members admitted to the channel, and only them", async () => {
    const { open, server } = await harness()
    const alice = await open(userToken(ALICE))
    const bob = await open(userToken(BOB))
    const eve = await open(userToken(EVE))
    const anon = await open(anonKey())
    await join(alice, LOT)
    await join(bob, LOT)
    await join(eve, LOT)
    await join(anon, LOT)

    await server.dispatchChange(outbox(LOT, "price", { amount: 120 }))
    const heard = await alice.next((m) => m.type === "broadcast")
    await bob.next((m) => m.type === "broadcast")
    await settle(eve)
    await settle(anon)

    expect(heard).toEqual({ type: "broadcast", channel: LOT, event: "price", payload: { amount: 120 } })
    expect(relayed(eve)).toEqual([])
    expect(relayed(anon)).toEqual([])
  })

  it("is not delivered to a member whose access was taken away since they joined", async () => {
    const { open, db, server } = await harness({ channelRecheckSeconds: 3600 })
    const alice = await open(userToken(ALICE))
    const bob = await open(userToken(BOB))
    await join(alice, LOT)
    await join(bob, LOT)
    db.unwatch(LOT_ID, ALICE)
    alice.send({ type: "auth", token: userToken(ALICE) })
    await alice.next(isSystem("error", "was withdrawn"))

    await server.dispatchChange(outbox(LOT, "price", { amount: 1 }))
    await bob.next((m) => m.type === "broadcast")
    await settle(alice)

    expect(relayed(alice)).toEqual([])
  })

  it("is never handed to a row subscriber as a change, nor reaches a channel with the same name elsewhere", async () => {
    const { open, server } = await harness()
    const service = await open(serviceToken())
    await join(service, "_supatype:realtime_outbox", { table: "realtime_outbox", schema: "_supatype", changes: true })

    await server.dispatchChange(outbox(LOT, "price", { amount: 1 }))
    await settle(service)

    expect(service.frames.filter((m) => m.type === "change")).toEqual([])
  })

  it("ignores a row that is not a well-formed broadcast, and the delete that follows every insert", async () => {
    const { open, server } = await harness()
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)

    await server.dispatchChange(change("_supatype", "realtime_outbox", "DELETE", { id: "1", topic: LOT, event: "price" }))
    await server.dispatchChange(outbox(LOT, "price", "not an object"))
    await server.dispatchChange(change("_supatype", "realtime_outbox", "INSERT", { id: "2", topic: 7, event: "x", payload: {} }))
    await settle(alice)

    expect(relayed(alice)).toEqual([])
  })
})

describe("a broadcast from the database to a topic nothing declares, when the environment says declared", () => {
  const outbox = (topic: string): WalChange =>
    change("_supatype", "realtime_outbox", "INSERT", { id: "1", topic, event: "bid", payload: { amount: 5 }, sender: ALICE })
  const SCRATCH = "scratch:1"

  /** The database says open and the environment says declared: the stricter of the two is declared. */
  const tightenedByEnv = (): Promise<Harness> => harness({ channels: "declared" }, (db) => { db.mode = "open" })

  it("is dropped before fan-out, even to a service-role listener who holds the channel", async () => {
    const { open, server } = await tightenedByEnv()
    const service = await open(serviceToken())
    await join(service, SCRATCH)

    await server.dispatchChange(outbox(SCRATCH))
    await settle(service)

    expect(relayed(service)).toEqual([])
  })

  it("is still delivered to a declared topic's listener under the same settings", async () => {
    const { open, server } = await tightenedByEnv()
    const alice = await open(userToken(ALICE))
    await join(alice, LOT)

    await server.dispatchChange(outbox(LOT))

    expect(await alice.next((m) => m.type === "broadcast")).toMatchObject({ channel: LOT, event: "bid" })
  })

  it("is still delivered when the effective mode is open", async () => {
    const { open, server } = await harness({}, (db) => { db.mode = "open" })
    const service = await open(serviceToken())
    await join(service, SCRATCH)

    await server.dispatchChange(outbox(SCRATCH))

    expect(await service.next((m) => m.type === "broadcast")).toMatchObject({ channel: SCRATCH })
  })

  it("is logged once per topic, not once per message", async () => {
    const { open, server } = await tightenedByEnv()
    const service = await open(serviceToken())
    await join(service, SCRATCH)
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)) })

    for (let i = 0; i < 3; i++) await server.dispatchChange(outbox(SCRATCH))
    spy.mockRestore()

    expect(lines.filter((l) => l.includes(SCRATCH))).toHaveLength(1)
  })
})
