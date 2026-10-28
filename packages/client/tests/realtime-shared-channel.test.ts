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
