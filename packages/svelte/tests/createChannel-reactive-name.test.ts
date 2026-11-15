/**
 * `createChannel` follows its name when it is a store: the old channel is left, its listeners go
 * with it, and `setup` runs on the new one. `onDestroy` is collected rather than registered with a
 * component.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { get, writable } from "svelte/store"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { sentFrames, simulateServerMessage, subscribedChannels } from "../../client/tests/helpers/mock-websocket.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createChannel } from "../src/createChannel.js"

afterEach(() => {
  for (const fn of lifecycle.destroy.splice(0)) fn()
  lifecycle.harness?.restore()
})

describe("createChannel with a store for its name", () => {
  it("moves to the new channel when the store changes, leaving the old channel behind", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const heard: string[] = []
    const name = writable("room:1")
    const { status } = createChannel(name, (channel) => channel.onBroadcast("ping", () => heard.push("ping")))
    await harness.settle()
    harness.ackJoins()
    expect(get(status)).toBe("connected")

    name.set("room:2")
    expect(get(status)).toBe("connecting")
    await harness.settle()

    const first = harness.sockets[0]
    expect(first === undefined ? [] : sentFrames(first).some((f) => f["type"] === "unsubscribe" && f["channel"] === "room:1")).toBe(true)
    expect(subscribedChannels(harness.socket())).toEqual(["room:2"])
    simulateServerMessage(harness.socket(), { type: "broadcast", channel: "room:1", event: "ping", payload: {} })
    expect(heard).toEqual([])
    harness.ackJoins()
    simulateServerMessage(harness.socket(), { type: "broadcast", channel: "room:2", event: "ping", payload: {} })
    expect(heard).toEqual(["ping"])
  })

  it("keeps a plain string working", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { status } = createChannel("room:1", () => undefined)
    await harness.settle()
    harness.ackJoins()
    expect(get(status)).toBe("connected")
  })
})
