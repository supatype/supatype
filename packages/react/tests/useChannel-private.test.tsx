/** `useChannel(name, setup, deps, { private: true })` joins as private and hands back the typed refusal. */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { isRealtimeChannelError } from "@supatype/client"
import { ackNewestJoin, simulateServerMessage, subscribeFrames } from "../../client/tests/helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const shared = vi.hoisted(() => ({ harness: null as SocketSwapHarness | null }))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: shared.harness?.realtime }),
}))

import { useChannel, type UseChannelResult } from "../src/useChannel.js"

let renderer: ReactTestRenderer | null = null
let latest: UseChannelResult | null = null

function Probe(): null {
  latest = useChannel("lot:42", () => undefined, [], { private: true })
  return null
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
  shared.harness?.restore()
})

async function mount(): Promise<SocketSwapHarness> {
  const harness = createSocketSwapHarness()
  shared.harness = harness
  act(() => {
    renderer = create(<Probe />)
  })
  await act(() => harness.settle())
  return harness
}

describe("useChannel with private: true", () => {
  it("joins as private once the server announces private_channels", async () => {
    const harness = await mount()
    act(() => {
      simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated", features: ["private_channels"] })
    })
    expect(subscribeFrames(harness.socket(), "lot:42")[0]?.["private"]).toBe(true)
  })

  it("hands back the unsupported-server error as a RealtimeChannelError", async () => {
    const harness = await mount()
    act(() => {
      simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated" })
    })
    expect(latest?.status).toBe("CHANNEL_ERROR")
    expect(isRealtimeChannelError(latest?.error)).toBe(true)
  })
})

describe("useChannel with a refused send", () => {
  it("exposes the refusal and keeps the channel SUBSCRIBED", async () => {
    const harness = await mount()
    act(() => {
      simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated", features: ["private_channels"] })
      ackNewestJoin(harness.socket(), "lot:42")
    })
    expect(latest?.refusal).toBeNull()
    act(() => {
      simulateServerMessage(harness.socket(), { type: "system", status: "error", code: "send_denied", message: "not allowed", channel: "lot:42" })
    })
    expect(latest?.refusal).toEqual({ channel: "lot:42", code: "send_denied", message: "not allowed" })
    expect(latest?.status).toBe("SUBSCRIBED")
    expect(latest?.error).toBeNull()
  })
})
