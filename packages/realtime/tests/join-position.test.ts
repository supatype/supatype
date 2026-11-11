import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { ReplicationListener, committedBefore, lsnValue, parseWal2json, SLOT_READ_QUERY } from "../src/replication.js"
import { RlsFilter, type DeliveryVerdict } from "../src/rls.js"
import type { JwtClaims } from "../src/auth.js"
import type { WalChange } from "../src/types.js"
import { connect, freePort, isSystem, settle, subscribe, testEnv, userToken, type Peer } from "./fixtures/socket.js"

/**
 * A join hears only changes committed after it.
 *
 * 0.9.2 release test (N-S5): a subscriber that joined right after rows were deleted received those
 * DELETEs. Replication reads the slot every poll interval and a change went to whoever was
 * subscribed when it was decoded, so a change committed before the join and decoded after it
 * reached the new subscriber.
 *
 * The WAL insert position is read when a join is taken, and a change whose commit ends at or before
 * it is not the join's. wal2json format 1 reports one row per transaction, at the end of its commit
 * record: a transaction that committed before the read ends at or before it, one that commits after
 * ends past it, which `join-position.integration.test.ts` asserts against a real slot.
 */

const JOIN_AT = "0/1A43810"

class FakeDatabaseFilter extends RlsFilter {
  position: string | null = JOIN_AT
  failing = false
  /** How many times the catalog and the WAL position were asked. */
  catalogReads = 0
  positionReads = 0
  /** While set, every position read waits on it. */
  held: Promise<void> | null = null

  constructor() {
    super("postgresql://nobody:nothing@127.0.0.1:1/none")
  }

  override async relationKind(): Promise<string | null> {
    this.catalogReads++
    return "r"
  }

  override async walPosition(): Promise<string | null> {
    this.positionReads++
    if (this.failing) throw new Error("connection refused")
    if (this.held !== null) await this.held
    return this.position
  }

  override async maskedColumns(): Promise<Set<string>> {
    return new Set()
  }

  override async judgeForDelivery(_claims: JwtClaims | null, change: WalChange): Promise<DeliveryVerdict> {
    return { send: change, redacted: { old: [], new: [] } }
  }
}

/** A position from its `X/Y` text, which every one in this suite is. */
function lsn(text: string): bigint {
  const value = lsnValue(text)
  if (value === null) throw new Error(`not an LSN: ${text}`)
  return value
}

function deleted(id: string, commitLsn?: string): WalChange {
  return {
    schema: "public",
    table: "note",
    event: "DELETE",
    newRecord: null,
    oldRecord: { id },
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
    ...(commitLsn !== undefined && { commitLsn: lsn(commitLsn) }),
  }
}

const deliveredIds = (peer: Peer, channel: string): unknown[] =>
  peer.frames.flatMap((m) => (m.type === "change" && m.channel === channel ? [m.payload.old?.["id"]] : []))

describe("LSN positions", () => {
  it("compares as numbers across the slash, not as text", () => {
    expect(lsnValue("1/0")! > lsnValue("0/FFFFFFFF")!).toBe(true)
    expect(lsnValue("0/1A43810")).toBe(0x1a43810n)
    expect(lsnValue("not an lsn")).toBeNull()
  })

  it("treats a commit ending at the join's position as before it", () => {
    expect(committedBefore(deleted("a", "0/1A43800"), lsn(JOIN_AT))).toBe(true)
    expect(committedBefore(deleted("a", JOIN_AT), lsn(JOIN_AT))).toBe(true)
    expect(committedBefore(deleted("a", "0/1A43811"), lsn(JOIN_AT))).toBe(false)
  })

  it("never withholds a change it cannot place", () => {
    expect(committedBefore(deleted("a"), lsn(JOIN_AT))).toBe(false)
    expect(committedBefore(deleted("a", "0/10"), undefined)).toBe(false)
    const unreadable = JSON.stringify({ change: [{ kind: "delete", schema: "public", table: "note" }] })
    expect(parseWal2json(unreadable, "not an lsn")[0]?.commitLsn).toBeUndefined()
  })

  it("carries the slot row's position onto every change in the transaction", () => {
    expect(SLOT_READ_QUERY).toMatch(/SELECT lsn, data FROM/)
    const data = JSON.stringify({
      timestamp: "2026-11-10 10:45:10.892331+00",
      change: [
        { kind: "insert", schema: "public", table: "note", columnnames: ["id"], columntypes: ["text"], columnvalues: ["1"] },
        { kind: "insert", schema: "public", table: "note", columnnames: ["id"], columntypes: ["text"], columnvalues: ["2"] },
      ],
    })
    expect(parseWal2json(data, JOIN_AT).map((c) => c.commitLsn)).toEqual([lsn(JOIN_AT), lsn(JOIN_AT)])
  })
})

describe("a join and the changes committed before it", () => {
  let server: RealtimeServer
  let filter: FakeDatabaseFilter
  let port: number
  const peers: Peer[] = []
  const open = async (): Promise<Peer> => {
    const peer = await connect(port, userToken("late-joiner"))
    peers.push(peer)
    return peer
  }

  beforeAll(async () => {
    vi.spyOn(ReplicationListener.prototype, "isConnected").mockReturnValue(true)
    port = await freePort()
    filter = new FakeDatabaseFilter()
    server = new RealtimeServer(testEnv(port), { rlsFilter: filter })
    await server.start()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
    vi.restoreAllMocks()
  })

  it("does not hear deletes committed before it joined, and hears the ones after", async () => {
    const peer = await open()
    await subscribe(peer, "notes", { table: "note" })
    await server.dispatchChange(deleted("before", "0/1A43800"))
    await server.dispatchChange(deleted("at", JOIN_AT))
    await server.dispatchChange(deleted("after", "0/1A43900"))
    await settle(peer)
    expect(deliveredIds(peer, "notes")).toEqual(["after"])
  })

  it("delivers everything, as before, when the position could not be read", async () => {
    const peer = await open()
    filter.failing = true
    try {
      await subscribe(peer, "blind", { table: "note" })
    } finally {
      filter.failing = false
    }
    await server.dispatchChange(deleted("old", "0/10"))
    await settle(peer)
    expect(deliveredIds(peer, "blind")).toEqual(["old"])
  })

  it("keeps the first join's position when the channel joins the same table again", async () => {
    const peer = await open()
    await subscribe(peer, "again", { table: "note" })
    filter.position = "0/1A44000"
    try {
      peer.send({ type: "subscribe", changes: true, channel: "again", table: "note", event: "DELETE" })
      // The first join's acknowledgement would satisfy a wait for this one, so round-trip instead.
      await settle(peer)
    } finally {
      filter.position = JOIN_AT
    }
    // Committed between the two joins: the first join was owed it, so the second still is.
    await server.dispatchChange(deleted("between", "0/1A43900"))
    await settle(peer)
    expect(deliveredIds(peer, "again")).toEqual(["between"])
  })

  it("does not ask for a position when the channel joins the same table again", async () => {
    const peer = await open()
    await subscribe(peer, "rejoin", { table: "note" })
    const reads = filter.positionReads
    peer.send({ type: "subscribe", changes: true, channel: "rejoin", table: "note", event: "DELETE", ref: "2" })
    await peer.next((m) => m.type === "system" && m.ref === "2")
    expect(filter.positionReads).toBe(reads)
  })

  // Round 2 (R2-RB2): a broadcast or presence join names the table its channel name reads as, as
  // every join does. With `changes: false` it is not a row join: nothing is asked of the database
  // for it, and no row change reaches it, even when a table of that name exists.
  it("asks the database nothing for a join that wants no row changes", async () => {
    const peer = await open()
    const [catalog, reads] = [filter.catalogReads, filter.positionReads]
    await subscribe(peer, "public:note", { schema: "public", table: "note", changes: false })
    expect([filter.catalogReads, filter.positionReads]).toEqual([catalog, reads])
  })

  it("delivers no row change to a join that wants none, though its name reads as a table", async () => {
    const peer = await open()
    await subscribe(peer, "public:note", { schema: "public", table: "note", changes: false })
    await server.dispatchChange(deleted("after", "0/1A44000"))
    await settle(peer)
    expect(deliveredIds(peer, "public:note")).toEqual([])
  })

  it("takes its own position when a channel that wanted no rows joins again for them", async () => {
    // The first join read no position, so the second is no rejoin: it holds back what came before it.
    const peer = await open()
    await subscribe(peer, "public:note", { schema: "public", table: "note", changes: false })
    peer.send({ type: "subscribe", changes: true, channel: "public:note", schema: "public", table: "note", ref: "rows" })
    await peer.next((m) => m.type === "system" && m.ref === "rows")
    await server.dispatchChange(deleted("before", "0/1A43800"))
    await server.dispatchChange(deleted("after", "0/1A44000"))
    await settle(peer)
    expect(deliveredIds(peer, "public:note")).toEqual(["after"])
  })

  it("shares one position read between joins that arrive together", async () => {
    const [first, second] = await Promise.all([open(), open()])
    const catalog = filter.catalogReads
    const reads = filter.positionReads
    let release = (): void => {}
    filter.held = new Promise<void>((resolve) => { release = resolve })
    try {
      first.send({ type: "subscribe", changes: true, channel: "together-1", table: "note" })
      second.send({ type: "subscribe", changes: true, channel: "together-2", table: "note" })
      // Both joins have reached their database checks once both have asked the catalog.
      await vi.waitFor(() => expect(filter.catalogReads).toBe(catalog + 2))
      expect(filter.positionReads).toBe(reads + 1)
    } finally {
      filter.held = null
      release()
    }
    await first.next(isSystem("ok", "subscribed to together-1"))
    await second.next(isSystem("ok", "subscribed to together-2"))
  })
})
