import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { ReplicationListener } from "../src/replication.js"
import { RlsFilter, type DeliveryVerdict } from "../src/rls.js"
import type { JwtClaims } from "../src/auth.js"
import type { ServerMessage, WalChange } from "../src/types.js"
import { connect, freePort, isSystem, serviceToken, settle, testEnv, userToken, type Peer } from "./fixtures/socket.js"

/**
 * A join for a table that does not exist is refused, naming the table.
 *
 * 0.9.2 release test (N-FF5): `{ table: "notes" }` when the table is `note`, and
 * `{ schema: "auth", table: "note" }`, were both acknowledged. The client reported SUBSCRIBED and
 * nothing ever arrived, the same silence RB4 was, now one typo away.
 */

/** The catalog this suite pretends the database has: `public.note`, and `public.note_list` as a view. */
const RELATIONS = new Map([
  ["public.note", "r"],
  ["public.note_list", "v"],
  ["auth.users", "r"],
])

/** Answers the catalog from {@link RELATIONS}, or fails like a database that went away. */
class FakeCatalogFilter extends RlsFilter {
  failing = false
  /** While set, every catalog read waits on it: a join held at its database check. */
  held: Promise<void> | null = null

  constructor() {
    super("postgresql://nobody:nothing@127.0.0.1:1/none")
  }

  override async relationKind(schema: string, table: string): Promise<string | null> {
    if (this.failing) throw new Error("connection refused")
    if (this.held !== null) await this.held
    return RELATIONS.get(`${schema}.${table}`) ?? null
  }

  /** Every role but service_role reads public tables only, as the auth schema is granted to nobody. */
  override async canRead(_role: string, schema: string): Promise<boolean> {
    return schema !== "auth"
  }

  override async walPosition(): Promise<string | null> {
    return null
  }

  override async maskedColumns(): Promise<Set<string>> {
    return new Set()
  }

  override async judgeForDelivery(_claims: JwtClaims | null, change: WalChange): Promise<DeliveryVerdict> {
    return { send: change, redacted: { old: [], new: [] } }
  }
}

const isRefusalOf = (channel: string) => (m: ServerMessage): boolean =>
  m.type === "system" && m.status === "error" && m.channel === channel

function noteInsert(table: string): WalChange {
  return {
    schema: "public",
    table,
    event: "INSERT",
    newRecord: { id: "n1", title: "hello" },
    oldRecord: null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
  }
}

describe("a join for a table that does not exist", () => {
  let server: RealtimeServer
  let filter: FakeCatalogFilter
  let port: number
  const peers: Peer[] = []
  const open = async (): Promise<Peer> => {
    const peer = await connect(port, userToken("typo-user"))
    peers.push(peer)
    return peer
  }

  beforeAll(async () => {
    // The check needs the database, and replication being up is how the server knows it has one.
    vi.spyOn(ReplicationListener.prototype, "isConnected").mockReturnValue(true)
    port = await freePort()
    filter = new FakeCatalogFilter()
    server = new RealtimeServer(testEnv(port), { rlsFilter: filter })
    await server.start()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
    vi.restoreAllMocks()
  })

  it("is refused with a message naming the table, for a misspelt name", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "notes:team", table: "notes", event: "*", ref: "1" })
    const reply = await peer.next((m) => m.type === "system" && m.ref === "1")
    expect(reply).toMatchObject({ status: "error", channel: "notes:team", ref: "1" })
    expect(reply.type === "system" && reply.message).toContain("public.notes")
  })

  it("is refused for the right table in the wrong schema", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "auth-notes", schema: "auth", table: "note", ref: "1" })
    const reply = await peer.next((m) => m.type === "system" && m.ref === "1")
    expect(reply).toMatchObject({ status: "error", channel: "auth-notes" })
    expect(reply.type === "system" && reply.message).toContain("auth.note")
  })

  it("is refused for a view, which no change is ever published for", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "list", table: "note_list", ref: "1" })
    const reply = await peer.next((m) => m.type === "system" && m.ref === "1")
    expect(reply).toMatchObject({ status: "error", channel: "list" })
    expect(reply.type === "system" && reply.message).toContain("public.note_list")
  })

  it("registers nothing, so no change reaches the refused channel", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "gone", table: "notes" })
    await peer.next(isRefusalOf("gone"))
    await server.dispatchChange(noteInsert("notes"))
    await settle(peer)
    expect(peer.frames.filter((m) => m.type === "change")).toHaveLength(0)
  })

  // 0.9.2 release test round 2 (R2-RB2): every join was checked, and a client sends the table its
  // channel name reads as on every join, row changes or not. `room:probe` reads as room.probe, so
  // broadcast and presence on any channel not named after a table were refused.
  it("acknowledges a join that does not ask for row changes, whatever table its name reads as", async () => {
    const [sender, listener] = [await open(), await open()]
    for (const peer of [sender, listener]) {
      peer.send({ type: "subscribe", channel: "room:probe", schema: "room", table: "probe", event: "*", ref: "j" })
      await peer.next(isSystem("ok", "subscribed to room:probe"))
    }
    sender.send({ type: "broadcast", channel: "room:probe", event: "ping", payload: { n: 1 } })
    await listener.next((m) => m.type === "broadcast" && m.channel === "room:probe")
  })

  // Round 2 (R2-S8): a join for auth.users reported SUBSCRIBED and nothing ever came, because every
  // change is withheld from a role that cannot read the table. The join now says so.
  it("is refused for a table the subscriber's role cannot read, naming the role", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "users", schema: "auth", table: "users", ref: "1" })
    const reply = await peer.next((m) => m.type === "system" && m.ref === "1")
    expect(reply).toMatchObject({ status: "error", channel: "users" })
    expect(reply.type === "system" && reply.message).toMatch(/authenticated[\s\S]*auth\.users/)
  })

  it("lets the service role join a table only it can read", async () => {
    const peer = await connect(port, serviceToken())
    peers.push(peer)
    peer.send({ type: "subscribe", changes: true, channel: "users-svc", schema: "auth", table: "users", ref: "1" })
    await peer.next(isSystem("ok", "subscribed to users-svc"))
  })

  it("still acknowledges a table that exists, and delivers its changes", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", changes: true, channel: "notes:ok", table: "note", ref: "7" })
    await peer.next(isSystem("ok", "subscribed to notes:ok"))
    await server.dispatchChange(noteInsert("note"))
    await peer.next((m) => m.type === "change" && m.channel === "notes:ok")
  })

  it("acknowledges as before when the catalog cannot be read", async () => {
    const peer = await open()
    filter.failing = true
    try {
      peer.send({ type: "subscribe", changes: true, channel: "blind", table: "anything" })
      await peer.next(isSystem("ok", "subscribed to blind"))
    } finally {
      filter.failing = false
    }
  })

  it("keeps a client's frames in order while a join waits on the catalog", async () => {
    const peer = await open()
    // Left before the check could answer: the join must not come back to life afterwards.
    peer.send({ type: "subscribe", changes: true, channel: "brief", table: "note", ref: "1" })
    peer.send({ type: "unsubscribe", channel: "brief" })
    peer.send({ type: "subscribe", changes: true, channel: "brief", table: "notes", ref: "2" })
    await settle(peer)
    const replies = peer.frames.filter((m) => m.type === "system" && m.ref !== undefined)
    expect(replies).toMatchObject([
      { status: "ok", message: "subscribed to brief", ref: "1" },
      { status: "error", channel: "brief", ref: "2" },
    ])
    await server.dispatchChange(noteInsert("note"))
    await settle(peer)
    expect(peer.frames.filter((m) => m.type === "change" && m.channel === "brief")).toHaveLength(0)
  })

  it("does not hold a broadcast on one channel behind a slow join on another", async () => {
    const sender = await open()
    const listener = await open()
    sender.send({ type: "subscribe", changes: true, channel: "room-b", table: "note" })
    listener.send({ type: "subscribe", changes: true, channel: "room-b", table: "note" })
    await Promise.all([sender, listener].map((p) => p.next(isSystem("ok", "subscribed to room-b"))))

    let release = (): void => {}
    filter.held = new Promise<void>((resolve) => { release = resolve })
    try {
      sender.send({ type: "subscribe", changes: true, channel: "room-a", table: "note", ref: "slow" })
      sender.send({ type: "broadcast", channel: "room-b", event: "ping", payload: { n: 1 } })
      await listener.next((m) => m.type === "broadcast" && m.channel === "room-b")
      expect(sender.frames.some((m) => m.type === "system" && m.ref === "slow")).toBe(false)
    } finally {
      filter.held = null
      release()
    }
    await sender.next(isSystem("ok", "subscribed to room-a"))
  })
})
