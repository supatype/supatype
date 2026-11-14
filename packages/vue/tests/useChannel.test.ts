/**
 * `useChannel` and `useRealtimeConnection`: the status across the sign-in swap, and the socket's own
 * state through a drop. The lifecycle hooks run directly, as in the `useSubscription` suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { describeStatusAcrossSignIn, createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

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

const unmount = (): void => {
  for (const fn of lifecycle.unmount.splice(0)) fn()
}

describeStatusAcrossSignIn(
  "useChannel",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = useChannel("public:task", () => undefined)
    return { status: () => status.value, error: () => error.value }
  },
  unmount,
)

describe("useChannel's connection", () => {
  afterEach(() => {
    unmount()
    lifecycle.harness?.restore()
  })

  it("tells a drop from a first connect, and leaves the channel on unmount", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { isConnected, connectionState } = useChannel("auction:1", () => undefined)
    expect(connectionState.value).toBe("connecting")
    await harness.settle()
    expect(connectionState.value).toBe("connected")
    expect(isConnected.value).toBe(true)

    harness.socket().onclose?.(new Event("close") as CloseEvent)
    expect(connectionState.value).toBe("connecting")
    expect(isConnected.value).toBe(false)

    unmount()
    expect(harness.realtime.connectionState).toBe("disconnected")
  })
})
