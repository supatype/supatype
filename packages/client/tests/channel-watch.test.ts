/**
 * `watchChannel` and `watchConnection`: what the Vue, Svelte and Solid `useChannel` equivalents share.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { watchChannel, watchConnection, type SubscriptionView, type RealtimeConnectionState } from "../src/bindings.js"
import { sentFrames, simulateServerMessage, subscribedChannels } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

let harness: SocketSwapHarness

beforeEach(() => {
  harness = createSocketSwapHarness()
})
afterEach(() => harness.restore())

describe("watchChannel", () => {
  it("hands setup the channel, joins, and reports the status as a binding view", async () => {
    const views: SubscriptionView[] = []
    const heard = vi.fn()
    watchChannel(
      harness.realtime,
      "auction:1",
      (channel) => channel.onBroadcast("outbid", heard),
      (view) => views.push(view),
    )
    await harness.settle()
    harness.ackJoins()
    simulateServerMessage(harness.socket(), { type: "broadcast", channel: "auction:1", event: "outbid", payload: { n: 1 } })

    expect(subscribedChannels(harness.socket())).toEqual(["auction:1"])
    expect(views.map((v) => v.status)).toEqual(["connected"])
    expect(heard).toHaveBeenCalledWith({ n: 1 })
  })

  it("leaves the channel on the returned unsubscribe", async () => {
    const stop = watchChannel(harness.realtime, "auction:1", () => undefined, () => undefined)
    await harness.settle()
    stop()

    expect(sentFrames(harness.socket()).some((f) => f["type"] === "unsubscribe" && f["channel"] === "auction:1")).toBe(true)
  })
})

describe("watchConnection", () => {
  it("reports the state it has now, then each change, and stops on unsubscribe", async () => {
    const seen: RealtimeConnectionState[] = []
    const stop = watchConnection(harness.realtime, (state) => seen.push(state))
    expect(seen).toEqual(["disconnected"])

    harness.realtime.channel("public:task").subscribe(() => undefined)
    await harness.settle()
    expect(seen).toEqual(["disconnected", "connecting", "connected"])

    stop()
    harness.realtime.disconnect()
    expect(seen).toHaveLength(3)
  })
})
