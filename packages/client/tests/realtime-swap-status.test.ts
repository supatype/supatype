/**
 * A channel's status follows the socket swap that signing in causes.
 *
 * Signing in replaces the realtime socket: the old one, opened as anon, is closed and a new one is
 * opened with the user's token, and every channel joins again on it. The swap emitted no status at
 * all, so a channel that had reported SUBSCRIBED on the anon socket went on reading SUBSCRIBED
 * while it had no join anywhere, and an insert made in that gap was never going to arrive. Found by
 * the framework-parity live suite, which had to watch the frames to know when the join was real.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ChannelStatus } from "../src/realtime.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

let harness: SocketSwapHarness
let seen: ChannelStatus[]

beforeEach(async () => {
  harness = createSocketSwapHarness()
  seen = []
  harness.realtime.channel("public:task").subscribe((status) => seen.push(status))
  await harness.settle()
  harness.ackJoins()
})

afterEach(() => harness.restore())

describe("channel status across the socket swap on sign-in", () => {
  it("reports SUBSCRIBING from the swap until the new socket acknowledges the join", async () => {
    expect(seen).toEqual(["SUBSCRIBED"])

    await harness.signIn()
    expect(harness.sockets).toHaveLength(2)
    expect(seen).toEqual(["SUBSCRIBED", "SUBSCRIBING"])

    harness.ackJoins()
    expect(seen).toEqual(["SUBSCRIBED", "SUBSCRIBING", "SUBSCRIBED"])
  })

  it("reports CHANNEL_ERROR when the new socket refuses the join", async () => {
    await harness.signIn()
    harness.refuseJoin()

    expect(seen).toEqual(["SUBSCRIBED", "SUBSCRIBING", "CHANNEL_ERROR"])
  })

  it("reports nothing when the token did not change, since no swap happens", async () => {
    await harness.realtime.reauthenticate()
    await harness.settle()

    expect(harness.sockets).toHaveLength(1)
    expect(seen).toEqual(["SUBSCRIBED"])
  })
})

describe("channel status on an explicit disconnect", () => {
  it("reports CLOSED, since nothing will reconnect the join it had", () => {
    harness.realtime.disconnect()

    expect(seen).toEqual(["SUBSCRIBED", "CLOSED"])
  })
})
