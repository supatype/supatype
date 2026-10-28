/**
 * Two handles on one channel name are independent until the last one leaves.
 *
 * `channel(name)` handed every caller the same state: the second `subscribe()` replaced the first
 * one's status callback, and the first `unsubscribe()` told the server to leave and deleted the
 * channel, listeners and all. Two `useSubscription` hooks with one channel name broke each other:
 * when one unmounted, the other stopped receiving changes while still reading SUBSCRIBED.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ChannelStatus, RealtimePayload } from "../src/realtime.js"
import { sentFrames, simulateServerMessage } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

const CHANNEL = "x"

let harness: SocketSwapHarness

function socket(): SocketSwapHarness["sockets"][number] {
  const ws = harness.sockets[harness.sockets.length - 1]
  if (ws === undefined) throw new Error("no socket has been opened")
  return ws
}

function unsubscribeFrames(): Array<Record<string, unknown>> {
  return sentFrames(socket()).filter((frame) => frame["type"] === "unsubscribe" && frame["channel"] === CHANNEL)
}

function deliverInsert(id: number): void {
  simulateServerMessage(socket(), {
    type: "change",
    channel: CHANNEL,
    event: "INSERT",
    payload: { old: null, new: { id } },
    timestamp: "2026-10-28T00:00:00Z",
  })
}

beforeEach(() => {
  harness = createSocketSwapHarness()
})

afterEach(() => harness.restore())

describe("two handles on one channel name", () => {
  it("keeps the second receiving changes once the first unsubscribes", async () => {
    const first: Array<RealtimePayload<Record<string, unknown>>> = []
    const second: Array<RealtimePayload<Record<string, unknown>>> = []
    const a = harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "t" }, (p) => first.push(p)).subscribe()
    harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "t" }, (p) => second.push(p)).subscribe()
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    deliverInsert(1)

    expect(first).toEqual([])
    expect(second.map((p) => p.new)).toEqual([{ id: 1 }])
    expect(unsubscribeFrames()).toEqual([])
  })

  it("tells the server to leave only when the last handle unsubscribes", async () => {
    const a = harness.realtime.channel(CHANNEL).subscribe()
    const b = harness.realtime.channel(CHANNEL).subscribe()
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    expect(unsubscribeFrames()).toEqual([])
    expect(socket().close).not.toHaveBeenCalled()

    b.unsubscribe()
    expect(unsubscribeFrames()).toHaveLength(1)
  })

  it("reports status to each handle's own callback", async () => {
    const first: ChannelStatus[] = []
    const second: ChannelStatus[] = []
    harness.realtime.channel(CHANNEL).subscribe((s) => first.push(s))
    harness.realtime.channel(CHANNEL).subscribe((s) => second.push(s))
    await harness.settle()
    harness.ackJoins()

    expect(first).toEqual(["SUBSCRIBED"])
    expect(second).toEqual(["SUBSCRIBED"])
  })

  it("stops a handle's presence and broadcast listeners when it unsubscribes, and only its own", async () => {
    const heard: string[] = []
    const a = harness.realtime.channel(CHANNEL)
      .onBroadcast("ping", () => heard.push("a"))
      .onPresence(() => heard.push("a-presence"))
      .subscribe()
    harness.realtime.channel(CHANNEL)
      .onBroadcast("ping", () => heard.push("b"))
      .onPresence(() => heard.push("b-presence"))
      .subscribe()
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    simulateServerMessage(socket(), { type: "broadcast", channel: CHANNEL, event: "ping", payload: {} })
    simulateServerMessage(socket(), { type: "presence", channel: CHANNEL, joins: [{ user_id: "u" }], leaves: [] })

    expect(heard).toEqual(["b", "b-presence"])
  })
})

/**
 * The join is made once, with the oldest handle's first row listener, and stays registered for that
 * table after that handle leaves. Rows used to be matched and labelled against whichever listener
 * was first now, so once the oldest handle unsubscribed, the next handle's listener for another
 * table was handed this table's rows under its own table's name.
 */
describe("rows on a channel whose joining handle has left", () => {
  it("go to listeners for the joined table, labelled with it, and not to one for another table", async () => {
    const audit: Array<RealtimePayload<Record<string, unknown>>> = []
    const messages: Array<RealtimePayload<Record<string, unknown>>> = []
    const a = harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "messages" }, () => {}).subscribe()
    harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "audit_log" }, (p) => audit.push(p)).subscribe()
    harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "messages" }, (p) => messages.push(p)).subscribe()
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    deliverInsert(1)

    expect(audit).toEqual([])
    expect(messages.map((p) => [p.table, p.new])).toEqual([["messages", { id: 1 }]])
  })
})

function subscribeFrames(): Array<Record<string, unknown>> {
  return sentFrames(socket()).filter((frame) => frame["type"] === "subscribe" && frame["channel"] === CHANNEL)
}

function ackJoin(channel: string): void {
  simulateServerMessage(socket(), { type: "system", status: "ok", message: `subscribed to ${channel}` })
}

/**
 * When the handle whose listener made the join leaves and no remaining listener is for that join,
 * the channel joins again for the oldest remaining listener. It used to stay registered for the
 * table the leaver listened to, and the others reported SUBSCRIBED and were sent nothing.
 */
describe("a channel whose joining handle leaves while the others listen to another table", () => {
  it("joins again for the remaining handle's table, event and filter, and delivers its rows", async () => {
    const statuses: ChannelStatus[] = []
    const messages: Array<RealtimePayload<Record<string, unknown>>> = []
    const a = harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "audit_log" }, () => {}).subscribe()
    harness.realtime
      .channel(CHANNEL)
      .on("postgres_changes", { event: "INSERT", table: "messages", filter: "room=eq.1" }, (p) => messages.push(p))
      .subscribe((s) => statuses.push(s))
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    const joins = subscribeFrames()
    expect(joins).toHaveLength(2)
    expect(joins[1]).toMatchObject({ schema: "public", table: "messages", event: "INSERT", filter: { room: "eq.1" } })
    // A join on a channel already joined replaces it on the server; leaving first would drop the
    // presence this socket tracks there.
    expect(unsubscribeFrames()).toEqual([])

    ackJoin(CHANNEL)
    deliverInsert(1)
    expect(messages.map((p) => [p.table, p.new])).toEqual([["messages", { id: 1 }]])
    expect(statuses).toEqual(["SUBSCRIBED", "SUBSCRIBING", "SUBSCRIBED"])
  })

  it("does not hand the new table's listeners a row that arrives before the new join is acknowledged", async () => {
    const messages: Array<RealtimePayload<Record<string, unknown>>> = []
    const a = harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "audit_log" }, () => {}).subscribe()
    harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "messages" }, (p) => messages.push(p)).subscribe()
    await harness.settle()
    harness.ackJoins()

    a.unsubscribe()
    // Sent before the server took the new join: an audit_log row.
    deliverInsert(1)
    ackJoin(CHANNEL)
    deliverInsert(2)
    expect(messages.map((p) => p.new)).toEqual([{ id: 2 }])
  })
})

/**
 * A join sent with no row listener names no table, and the server reads one from the channel name.
 * Rows were matched and labelled against whichever row listener came first instead, so a listener
 * for another table added afterwards was handed the channel's rows under its own table's name.
 */
describe("rows on a channel joined before any row listener", () => {
  it("belong to the table the channel name gives, as the server reads it", async () => {
    const invoices: Array<RealtimePayload<Record<string, unknown>>> = []
    const orders: Array<RealtimePayload<Record<string, unknown>>> = []
    const name = "public:orders"
    const handle = harness.realtime.channel(name).onBroadcast("ping", () => {}).subscribe()
    await harness.settle()
    harness.ackJoins()

    handle.on("postgres_changes", { event: "*", table: "invoices" }, (p) => invoices.push(p))
    handle.on("postgres_changes", { event: "*", table: "orders" }, (p) => orders.push(p))
    simulateServerMessage(socket(), {
      type: "change",
      channel: name,
      event: "INSERT",
      payload: { old: null, new: { id: 1 } },
      timestamp: "2026-10-28T00:00:00Z",
    })

    expect(invoices).toEqual([])
    expect(orders.map((p) => [p.schema, p.table, p.new])).toEqual([["public", "orders", { id: 1 }]])
  })
})
