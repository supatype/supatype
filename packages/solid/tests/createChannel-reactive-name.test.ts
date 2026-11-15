/**
 * `createChannel` follows its name when it is an accessor: the old channel is left, its listeners
 * go with it, and `setup` runs on the new one.
 *
 * Under Node, `solid-js` resolves to its server build, where effects never run, so this suite swaps
 * in the browser build: what is under test is that an effect tracks the name.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { sentFrames, simulateServerMessage, subscribedChannels } from "../../client/tests/helpers/mock-websocket.js"

const lifecycle = vi.hoisted(() => ({ dispose: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("solid-js", () => import("solid-js/dist/solid.js"))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createRoot, createSignal } from "solid-js"
import { createChannel } from "../src/createChannel.js"

afterEach(() => {
  for (const fn of lifecycle.dispose.splice(0)) fn()
  lifecycle.harness?.restore()
})

describe("createChannel with a reactive name", () => {
  it("moves to the new channel when the accessor changes, leaving the old channel behind", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const heard: string[] = []
    const [name, setName] = createSignal("room:1")
    const result = createRoot((dispose) => {
      lifecycle.dispose.push(dispose)
      return createChannel(name, (channel) => channel.onBroadcast("ping", () => heard.push("ping")))
    })
    await harness.settle()
    harness.ackJoins()
    expect(result.status()).toBe("connected")

    setName("room:2")
    expect(result.status()).toBe("connecting")
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
    const result = createRoot((dispose) => {
      lifecycle.dispose.push(dispose)
      return createChannel("room:1", () => undefined)
    })
    await harness.settle()
    harness.ackJoins()
    expect(result.status()).toBe("connected")
  })
})
