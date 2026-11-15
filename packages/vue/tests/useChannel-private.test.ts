/** `useChannel(name, setup, { private: true })` joins as private and shows the typed refusal. */

import { afterEach, describe, expect, it, vi } from "vitest"
import { isRealtimeChannelError } from "@supatype/client"
import { ackNewestJoin, subscribeFrames, simulateServerMessage } from "../../client/tests/helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

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

describe("useChannel with private: true", () => {
  it("joins as private once the server announces private_channels", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    useChannel("lot:42", () => undefined, { private: true })
    await harness.settle()
    simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated", features: ["private_channels"] })
    expect(subscribeFrames(harness.socket(), "lot:42")[0]?.["private"]).toBe(true)
  })

  it("exposes the unsupported-server error as a RealtimeChannelError", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { status, error } = useChannel("lot:42", () => undefined, { private: true })
    await harness.settle()
    simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated" })
    expect(status.value).toBe("error")
    expect(isRealtimeChannelError(error.value)).toBe(true)
  })
})

describe("useChannel with a refused send", () => {
  it("exposes the refusal and keeps the status connected", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { status, refusal } = useChannel("lot:42", () => undefined, { private: true })
    await harness.settle()
    simulateServerMessage(harness.socket(), { type: "system", status: "ok", message: "authenticated", features: ["private_channels"] })
    ackNewestJoin(harness.socket(), "lot:42")
    expect(refusal.value).toBeNull()
    simulateServerMessage(harness.socket(), { type: "system", status: "error", code: "send_denied", message: "not allowed", channel: "lot:42" })
    expect(refusal.value).toEqual({ channel: "lot:42", code: "send_denied", message: "not allowed" })
    expect(status.value).toBe("connected")
  })
})
