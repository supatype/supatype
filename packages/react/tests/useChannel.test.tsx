/**
 * `useChannel(name, setup)`: one channel with as many listeners as setup registers, its status, and
 * the socket's own state.
 *
 * `useSubscription` takes one `postgres_changes` listener, so a component that wanted rows, presence
 * and a broadcast on one channel had to leave the hook and manage the handle by hand.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import type { ChannelSubscription } from "@supatype/client"
import { sentFrames, simulateServerMessage, subscribedChannels } from "../../client/tests/helpers/mock-websocket.js"
import { closeEvent } from "../../client/tests/helpers/close-event.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const shared = vi.hoisted(() => ({ harness: null as SocketSwapHarness | null }))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: shared.harness?.realtime }),
}))

import { useChannel, type UseChannelResult } from "../src/useChannel.js"

let renderer: ReactTestRenderer | null = null
let latest: UseChannelResult | null = null
let setup: (channel: ChannelSubscription<Record<string, unknown>>) => void = () => undefined

function Probe({ name }: { name: string }): null {
  latest = useChannel(name, (channel) => setup(channel), [name])
  return null
}

function mount(name = "auction:1"): SocketSwapHarness {
  const harness = createSocketSwapHarness()
  shared.harness = harness
  act(() => {
    renderer = create(<Probe name={name} />)
  })
  return harness
}

function framesOn(harness: SocketSwapHarness): Array<Record<string, unknown>> {
  const first = harness.sockets[0]
  return first === undefined ? [] : sentFrames(first)
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
  setup = () => undefined
  shared.harness?.restore()
})

describe("useChannel", () => {
  it("hands setup the channel and registers every listener it adds on one join", async () => {
    const broadcasts = vi.fn()
    setup = (channel) => {
      channel.on("postgres_changes", { event: "*", table: "bid" }, () => undefined)
      channel.onBroadcast("outbid", broadcasts)
    }
    const harness = mount()
    await act(() => harness.settle())

    expect(subscribedChannels(harness.socket())).toEqual(["auction:1"])
    act(() => {
      simulateServerMessage(harness.socket(), { type: "broadcast", channel: "auction:1", event: "outbid", payload: { by: "x" } })
    })
    expect(broadcasts).toHaveBeenCalledWith({ by: "x" })
  })

  it("reports status, then the connection, through a drop", async () => {
    const harness = mount()
    expect(latest?.status).toBe("SUBSCRIBING")
    await act(() => harness.settle())
    expect(latest?.isConnected).toBe(true)
    expect(latest?.connectionState).toBe("connected")

    act(() => harness.ackJoins())
    expect(latest?.status).toBe("SUBSCRIBED")

    act(() => {
      harness.socket().onclose?.(closeEvent())
    })
    expect(latest?.isConnected).toBe(false)
    expect(latest?.connectionState).toBe("connecting")
  })

  it("leaves the channel when the component unmounts", async () => {
    const harness = mount()
    await act(() => harness.settle())

    act(() => renderer?.unmount())
    renderer = null

    expect(framesOn(harness).some((f) => f["type"] === "unsubscribe" && f["channel"] === "auction:1")).toBe(true)
  })

  it("moves to the new channel when the name changes, leaving the old one", async () => {
    const harness = mount("auction:1")
    await act(() => harness.settle())

    act(() => renderer?.update(<Probe name="auction:2" />))
    await act(() => harness.settle())

    // Leaving the only channel closes the socket, so the old channel's leave is on the first one
    // and the new join is on whichever socket the name change opened.
    expect(framesOn(harness).some((f) => f["type"] === "unsubscribe" && f["channel"] === "auction:1")).toBe(true)
    expect(subscribedChannels(harness.socket())).toEqual(["auction:2"])
  })

  it("reads the refusal reason with a CHANNEL_ERROR", async () => {
    const harness = mount()
    await act(() => harness.settle())
    act(() => harness.refuseJoin())

    expect(latest?.status).toBe("CHANNEL_ERROR")
    expect(latest?.error).not.toBeNull()
  })
})
