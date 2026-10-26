/**
 * `watchTable`, the channel wiring the Vue, Svelte and Solid bindings share.
 *
 * Each binding's own suite drives it through a sign-in; these cover what that does not: every
 * channel status, and the row merge on update and delete.
 */

import { describe, it, expect, afterEach } from "vitest"
import { applyRowChange, subscriptionViewOf, watchTable, type SubscriptionView } from "../src/table-subscription.js"
import type { ChannelStatus, RealtimePayload } from "../src/realtime.js"
import { simulateServerMessage } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

interface Row {
  id: number
  title: string
}

function change(eventType: "INSERT" | "UPDATE" | "DELETE", row: Row): RealtimePayload<Row> {
  return {
    eventType,
    new: eventType === "DELETE" ? null : row,
    old: eventType === "INSERT" ? null : row,
    schema: "public",
    table: "task",
    commitTimestamp: "2026-01-01T00:00:00Z",
  }
}

describe("subscriptionViewOf", () => {
  it.each<[ChannelStatus, SubscriptionView["status"], boolean]>([
    ["SUBSCRIBING", "connecting", false],
    ["SUBSCRIBED", "connected", false],
    ["CLOSED", "disconnected", false],
    ["CHANNEL_ERROR", "error", true],
    ["TIMED_OUT", "error", true],
  ])("%s reads %s", (channelStatus, status, hasError) => {
    const view = subscriptionViewOf(channelStatus)
    expect(view.status).toBe(status)
    expect(view.error !== null).toBe(hasError)
  })
})

describe("applyRowChange", () => {
  it("appends an insert, replaces an update and drops a delete, matched on id", () => {
    let rows = applyRowChange<Row>(null, change("INSERT", { id: 1, title: "a" }))
    rows = applyRowChange(rows, change("INSERT", { id: 2, title: "b" }))
    rows = applyRowChange(rows, change("UPDATE", { id: 1, title: "a2" }))
    expect(rows).toEqual([{ id: 1, title: "a2" }, { id: 2, title: "b" }])

    rows = applyRowChange(rows, change("DELETE", { id: 2, title: "b" }))
    expect(rows).toEqual([{ id: 1, title: "a2" }])
  })
})

describe("watchTable", () => {
  let harness: SocketSwapHarness

  afterEach(() => harness.restore())

  /** The channel each subscribe frame on the first socket named, in order. */
  function subscribedChannels(): string[] {
    return harness.sockets[0]!.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; channel: string })
      .filter((frame) => frame.type === "subscribe")
      .map((frame) => frame.channel)
  }

  it("hands the binding each change's rows and each status", async () => {
    harness = createSocketSwapHarness()
    const rowsSeen: Row[][] = []
    const statuses: string[] = []
    const stop = watchTable<Row>(harness.realtime, "task", { event: "INSERT" }, {
      rows: (rows) => rowsSeen.push(rows),
      status: (view) => statuses.push(view.status),
    })
    await harness.settle()
    harness.ackJoins()
    simulateServerMessage(harness.sockets[0]!, {
      type: "change",
      channel: subscribedChannels()[0],
      event: "INSERT",
      payload: { old: null, new: { id: 1, title: "a" } },
      timestamp: "2026-01-01T00:00:00Z",
    })
    stop()

    expect(statuses).toEqual(["connected"])
    expect(rowsSeen).toEqual([[{ id: 1, title: "a" }]])
  })

  it("gives two watchers of one table a channel each, as from(table).subscribe() does", async () => {
    harness = createSocketSwapHarness()
    const quiet = { rows: (): void => undefined, status: (): void => undefined }
    const first = watchTable<Row>(harness.realtime, "task", undefined, quiet)
    const second = watchTable<Row>(harness.realtime, "task", undefined, quiet)
    await harness.settle()

    const [a, b] = subscribedChannels()
    expect(a).toMatch(/^public:task:\d+$/)
    expect(b).toMatch(/^public:task:\d+$/)
    expect(a).not.toBe(b)
    first()
    second()
  })
})
