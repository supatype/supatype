/**
 * A row listener added to a channel already joined without one gets a join that delivers its rows.
 *
 * A join made for broadcast or presence alone carries `changes: false`, and the server sends it no
 * rows. A row listener added after that, on the same handle or a second handle with the same name,
 * used to find the join already sent: `subscribe()` reported SUBSCRIBED at once, no second frame
 * went out, and no row ever arrived (0.9.2 release test, FF-1).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ChannelStatus, RealtimePayload } from "../src/realtime.js"
import { ackNewestJoin, deliverInsert, simulateServerMessage, subscribeFrames } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

let harness: SocketSwapHarness

/** A channel joined for broadcast alone, with that join sent and acknowledged. */
async function joinedForBroadcast(channel: string): Promise<{ statuses: ChannelStatus[] }> {
  const statuses: ChannelStatus[] = []
  harness.realtime.channel(channel).onBroadcast("ping", () => {}).subscribe((s) => statuses.push(s))
  await harness.settle()
  ackNewestJoin(harness.socket(), channel)
  return { statuses }
}

beforeEach(() => {
  harness = createSocketSwapHarness()
})

afterEach(() => harness.restore())

describe("a row listener added to a channel joined for broadcast", () => {
  it("on a second handle joins again for its rows and reports SUBSCRIBED only once that join is acknowledged", async () => {
    const first = await joinedForBroadcast("room:x")
    const statuses: ChannelStatus[] = []
    const rows: Array<RealtimePayload<Record<string, unknown>>> = []
    harness.realtime
      .channel("room:x")
      .on("postgres_changes", { event: "INSERT", table: "note" }, (p) => rows.push(p))
      .subscribe((s) => statuses.push(s))

    const joins = subscribeFrames(harness.socket(), "room:x")
    expect(joins.map((frame) => frame["changes"])).toEqual([false, true])
    expect(joins[1]).toMatchObject({ schema: "public", table: "note", event: "INSERT" })
    expect(statuses).toEqual([])

    ackNewestJoin(harness.socket(), "room:x")
    deliverInsert(harness.socket(), "room:x", 1)
    expect(statuses).toEqual(["SUBSCRIBED"])
    // The broadcast join kept serving it until the server took the rows join in its place.
    expect(first.statuses).toEqual(["SUBSCRIBED"])
    expect(rows.map((p) => [p.table, p.new])).toEqual([["note", { id: 1 }]])
  })

  it("on the same handle joins again for its rows", async () => {
    const statuses: ChannelStatus[] = []
    const rows: Array<RealtimePayload<Record<string, unknown>>> = []
    const handle = harness.realtime.channel("room:x").onBroadcast("ping", () => {}).subscribe()
    await harness.settle()
    ackNewestJoin(harness.socket(), "room:x")

    handle.on("postgres_changes", { event: "INSERT", table: "note" }, (p) => rows.push(p)).subscribe((s) => statuses.push(s))
    expect(subscribeFrames(harness.socket(), "room:x").map((frame) => frame["changes"])).toEqual([false, true])
    expect(statuses).toEqual([])

    ackNewestJoin(harness.socket(), "room:x")
    deliverInsert(harness.socket(), "room:x", 1)
    expect(statuses).toEqual(["SUBSCRIBED"])
    expect(rows.map((p) => p.new)).toEqual([{ id: 1 }])
  })

  it("on a channel named after that table joins again for its rows", async () => {
    await joinedForBroadcast("note")
    const rows: Array<RealtimePayload<Record<string, unknown>>> = []
    harness.realtime.channel("note").on("postgres_changes", { event: "INSERT", table: "note" }, (p) => rows.push(p)).subscribe()

    const joins = subscribeFrames(harness.socket(), "note")
    expect(joins.map((frame) => frame["changes"])).toEqual([false, true])
    expect(joins[1]).toMatchObject({ schema: "public", table: "note", event: "INSERT" })

    ackNewestJoin(harness.socket(), "note")
    deliverInsert(harness.socket(), "note", 1)
    expect(rows.map((p) => p.new)).toEqual([{ id: 1 }])
  })

  it("joins again when the broadcast join is still waiting for its reply, and ignores that stale reply", async () => {
    const statuses: ChannelStatus[] = []
    harness.realtime.channel("room:x").onBroadcast("ping", () => {}).subscribe()
    await harness.settle()
    const broadcastJoin = subscribeFrames(harness.socket(), "room:x")[0]

    harness.realtime.channel("room:x").on("postgres_changes", { event: "INSERT", table: "note" }, () => {}).subscribe((s) => statuses.push(s))
    expect(subscribeFrames(harness.socket(), "room:x").map((frame) => frame["changes"])).toEqual([false, true])

    simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "subscribed to room:x", ref: broadcastJoin?.["ref"] })
    expect(statuses).toEqual([])
    ackNewestJoin(harness.socket(), "room:x")
    expect(statuses).toEqual(["SUBSCRIBED"])
  })
})

/** The server refuses the newest join on `channel`, as it refuses a table the caller cannot read. */
function refuseNewestJoin(channel: string): void {
  const newest = subscribeFrames(harness.socket(), channel).at(-1)
  simulateServerMessage(harness.socket(), {
    type: "system",
    status: "error",
    message: "role anon cannot read public.note",
    channel,
    ref: newest?.["ref"],
  })
}

/**
 * A refused rejoin registered nothing, so the join it was to replace still stands on the server and
 * still serves broadcast and presence. Every handle on the name was told CHANNEL_ERROR and stayed
 * there, and every member was said to have left (0.9.2 round 4, S-1).
 */
describe("a rows rejoin the server refuses", () => {
  it("fails the handle whose rows it asked for, and leaves the broadcast handle SUBSCRIBED", async () => {
    const first = await joinedForBroadcast("room:x")
    const statuses: Array<[ChannelStatus, string | undefined]> = []
    harness.realtime
      .channel("room:x")
      .on("postgres_changes", { event: "INSERT", table: "note" }, () => {})
      .subscribe((s, err) => statuses.push([s, err?.message]))

    refuseNewestJoin("room:x")
    expect(statuses).toEqual([["CHANNEL_ERROR", "role anon cannot read public.note"]])
    expect(first.statuses).toEqual(["SUBSCRIBED"])
  })

  it("keeps who is present, as the standing join keeps reporting it", async () => {
    const seen: Array<{ joins: string[]; leaves: string[] }> = []
    harness.realtime
      .channel("room:x")
      .onPresence(({ joins, leaves }) => seen.push({ joins: joins.map((m) => m.user_id), leaves: leaves.map((m) => m.user_id) }))
      .subscribe()
    await harness.settle()
    ackNewestJoin(harness.socket(), "room:x")
    const presence = (joins: string[], leaves: string[]): void =>
      simulateServerMessage(harness.socket(), {
        type: "presence",
        channel: "room:x",
        joins: joins.map((user_id) => ({ user_id })),
        leaves: leaves.map((user_id) => ({ user_id })),
      })
    presence(["u1", "u2"], [])

    harness.realtime.channel("room:x").on("postgres_changes", { event: "INSERT", table: "note" }, () => {}).subscribe()
    // While the rejoin waits, the join still standing reports a leave.
    presence([], ["u2"])
    refuseNewestJoin("room:x")
    expect(seen).toEqual([
      { joins: ["u1", "u2"], leaves: [] },
      { joins: [], leaves: ["u2"] },
    ])
  })

  it("is told who is present again once a rejoin is taken, after its old members leave", async () => {
    const seen: Array<{ joins: string[]; leaves: string[] }> = []
    harness.realtime
      .channel("room:x")
      .onPresence(({ joins, leaves }) => seen.push({ joins: joins.map((m) => m.user_id), leaves: leaves.map((m) => m.user_id) }))
      .subscribe()
    await harness.settle()
    ackNewestJoin(harness.socket(), "room:x")
    simulateServerMessage(harness.socket(), { type: "presence", channel: "room:x", joins: [{ user_id: "u1" }], leaves: [] })

    harness.realtime.channel("room:x").on("postgres_changes", { event: "INSERT", table: "note" }, () => {}).subscribe()
    expect(seen).toHaveLength(1)
    ackNewestJoin(harness.socket(), "room:x")
    // The server follows the reply with who is present, so a page counting joins minus leaves
    // counts u1 once.
    simulateServerMessage(harness.socket(), { type: "presence", channel: "room:x", joins: [{ user_id: "u1" }], leaves: [] })
    expect(seen).toEqual([
      { joins: ["u1"], leaves: [] },
      { joins: [], leaves: ["u1"] },
      { joins: ["u1"], leaves: [] },
    ])
  })

  it("sends no further join once the refused handle leaves", async () => {
    const first = await joinedForBroadcast("room:x")
    const rows = harness.realtime.channel("room:x").on("postgres_changes", { event: "INSERT", table: "note" }, () => {}).subscribe()
    refuseNewestJoin("room:x")
    rows.unsubscribe()
    expect(subscribeFrames(harness.socket(), "room:x")).toHaveLength(2)
    expect(first.statuses.at(-1)).toBe("SUBSCRIBED")
  })
})

describe("a row listener added to a channel whose join already delivers rows", () => {
  it("sends no second join", async () => {
    harness.realtime.channel("room:x").on("postgres_changes", { event: "INSERT", table: "note" }, () => {}).subscribe()
    await harness.settle()
    ackNewestJoin(harness.socket(), "room:x")

    const statuses: ChannelStatus[] = []
    harness.realtime.channel("room:x").onBroadcast("ping", () => {}).on("postgres_changes", { event: "*", table: "note" }, () => {}).subscribe((s) => statuses.push(s))

    expect(subscribeFrames(harness.socket(), "room:x")).toHaveLength(1)
    expect(statuses).toEqual(["SUBSCRIBED"])
  })
})
