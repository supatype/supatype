/**
 * Presence counted from joins and leaves stays true across a socket swap.
 *
 * The server tells a channel's newcomer who is already there as joins, and it does so on every
 * join, including the one each channel makes again on the socket that signing in opens. Leaves
 * for the old socket's members never arrive (that socket is gone), so a page counting joins minus
 * leaves read every member twice after signing in. The client now leaves, for its listeners,
 * everyone it had been told about when the socket that told it goes away.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { PresenceEntry } from "../src/realtime.js"
import { simulateServerMessage } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

const CHANNEL = "lobby:lobby"

let harness: SocketSwapHarness
let here: number
let leaves: PresenceEntry[]

function newest(): SocketSwapHarness["sockets"][number] {
  const socket = harness.sockets[harness.sockets.length - 1]
  if (socket === undefined) throw new Error("no socket has been opened")
  return socket
}

function serverSays(joins: PresenceEntry[], left: PresenceEntry[] = []): void {
  simulateServerMessage(newest(), { type: "presence", channel: CHANNEL, joins, leaves: left })
}

beforeEach(async () => {
  harness = createSocketSwapHarness()
  here = 0
  leaves = []
  const channel = harness.realtime.channel(CHANNEL)
  channel.onPresence((event) => {
    here += event.joins.length - event.leaves.length
    leaves.push(...event.leaves)
  })
  channel.subscribe()
  await harness.settle()
  harness.ackJoins()
})

afterEach(() => harness.restore())

describe("presence across the socket swap on sign-in", () => {
  it("counts each member once after the new socket's join sends the state again", async () => {
    serverSays([{ user_id: "first" }, { user_id: "second" }])
    expect(here).toBe(2)

    await harness.signIn()
    harness.ackJoins()
    serverSays([{ user_id: "first" }, { user_id: "second" }])

    expect(here).toBe(2)
  })

  it("leaves everyone it had been told about when the socket goes away", async () => {
    serverSays([{ user_id: "first" }, { user_id: "second" }])
    serverSays([], [{ user_id: "first" }])

    await harness.signIn()

    expect(here).toBe(0)
    expect(leaves).toEqual([{ user_id: "first" }, { user_id: "second" }])
  })

  it("tells a channel nobody joined nothing when the socket goes away", () => {
    harness.realtime.disconnect()

    expect(leaves).toEqual([])
  })
})
