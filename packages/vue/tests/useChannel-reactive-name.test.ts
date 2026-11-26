/**
 * `useChannel` follows its name when it is a ref or a getter: the old channel is left, its listeners
 * go with it, and `setup` runs on the new one. The lifecycle hooks run directly, as elsewhere.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref, type MaybeRefOrGetter } from "vue"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { sentFrames, simulateServerMessage, subscribedChannels } from "../../client/tests/helpers/mock-websocket.js"

const lifecycle = vi.hoisted(() => ({ unmount: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { useChannel } from "../src/useChannel.js"

afterEach(() => {
  for (const fn of lifecycle.unmount.splice(0)) fn()
  lifecycle.harness?.restore()
})

describe("useChannel with a reactive name", () => {
  it.each(["a ref", "a getter"])("moves to the new channel when %s changes", async (label) => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const heard: string[] = []
    const name = ref("room:1")
    const given: MaybeRefOrGetter<string> = label === "a ref" ? name : () => name.value
    const { status } = useChannel(given, (channel) => channel.onBroadcast("ping", () => heard.push("ping")))
    await harness.settle()
    harness.ackJoins()
    expect(status.value).toBe("connected")

    name.value = "room:2"
    await nextTick()
    expect(status.value).toBe("connecting")
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
    const { status } = useChannel("room:1", () => undefined)
    await harness.settle()
    harness.ackJoins()
    expect(status.value).toBe("connected")
  })
})
