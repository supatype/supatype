/**
 * The bindings' shared channel helpers carry the `private` option to the join, and keep the typed
 * refusal a private join can get instead of flattening it to a message.
 */

import { afterEach, describe, expect, it } from "vitest"
import { channelSlot, watchChannel } from "../src/channel-watch.js"
import { RealtimeChannelError } from "../src/errors.js"
import type { SubscriptionView } from "../src/table-subscription.js"
import { ackNewestJoin, simulateServerMessage, subscribeFrames } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

let harness: SocketSwapHarness

afterEach(() => harness.restore())

function greet(features: string[]): void {
  simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated", features })
}

describe("watchChannel with private: true", () => {
  it("joins as private", async () => {
    harness = createSocketSwapHarness()
    watchChannel(harness.realtime, "lot:42", () => undefined, () => undefined, { private: true })
    await harness.settle()
    greet(["private_channels"])
    expect(subscribeFrames(harness.socket(), "lot:42")[0]?.["private"]).toBe(true)
  })

  it("shows the typed error, with its reason, when the join is refused", async () => {
    harness = createSocketSwapHarness()
    const views: SubscriptionView[] = []
    watchChannel(harness.realtime, "lot:42", () => undefined, (view) => views.push(view), { private: true })
    await harness.settle()
    greet(["private_channels"])
    simulateServerMessage(harness.socket(), {
      type: "system",
      status: "error",
      message: "lot:42 was opened as private, but no Channel declaration matches it",
      channel: "lot:42",
      ref: subscribeFrames(harness.socket(), "lot:42")[0]?.["ref"],
    })
    const error = views.at(-1)?.error
    expect(views.at(-1)?.status).toBe("error")
    expect(error).toBeInstanceOf(RealtimeChannelError)
    expect(error instanceof RealtimeChannelError && error.reason).toBe("not_declared")
  })

  it("shows the unsupported-server error without sending a join", async () => {
    harness = createSocketSwapHarness()
    const views: SubscriptionView[] = []
    watchChannel(harness.realtime, "lot:42", () => undefined, (view) => views.push(view), { private: true })
    await harness.settle()
    greet([])
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(0)
    const error = views.at(-1)?.error
    expect(error instanceof RealtimeChannelError && error.reason).toBe("unsupported_server")
  })
})

describe("channelSlot with private: true", () => {
  it("joins every channel it moves to as private", async () => {
    harness = createSocketSwapHarness()
    const slot = channelSlot(harness.realtime, () => undefined, () => undefined, { private: true })
    slot.join("lot:1")
    await harness.settle()
    greet(["private_channels"])
    expect(subscribeFrames(harness.socket(), "lot:1")[0]?.["private"]).toBe(true)
    // Leaving the only channel closes the socket, so the next one meets a new socket and its greeting.
    slot.join("lot:2")
    await harness.settle()
    greet(["private_channels"])
    expect(subscribeFrames(harness.socket(), "lot:2")[0]?.["private"]).toBe(true)
  })
})

describe("watchChannel and channelSlot with a refused send", () => {
  const frame = { type: "system", status: "error", code: "send_denied", message: "not allowed", channel: "lot:42" } as const

  it("hands a refused send to onRefused and leaves the view connected", async () => {
    harness = createSocketSwapHarness()
    const views: SubscriptionView[] = []
    const refused: unknown[] = []
    watchChannel(harness.realtime, "lot:42", () => undefined, (view) => views.push(view), { private: true }, (r) => refused.push(r))
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    simulateServerMessage(harness.socket(), frame)
    expect(refused).toEqual([{ channel: "lot:42", code: "send_denied", message: "not allowed" }])
    expect(views.at(-1)?.status).toBe("connected")
  })

  it("does the same through a slot", async () => {
    harness = createSocketSwapHarness()
    const refused: unknown[] = []
    const slot = channelSlot(harness.realtime, () => undefined, () => undefined, { private: true }, (r) => refused.push(r))
    slot.join("lot:42")
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    simulateServerMessage(harness.socket(), frame)
    expect(refused).toHaveLength(1)
    slot.leave()
  })
})
