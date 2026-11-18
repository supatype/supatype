/**
 * `createChannel` and `createRealtimeConnection`: the status across the sign-in swap, and the
 * socket's own state through a drop. `onMount` runs directly and `onCleanup` is collected, as in the
 * `createSubscription` suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { describeStatusAcrossSignIn, createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { closeEvent } from "../../client/tests/helpers/mock-websocket.js"

const lifecycle = vi.hoisted(() => ({ cleanup: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => lifecycle.cleanup.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createChannel } from "../src/createChannel.js"

const cleanup = (): void => {
  for (const fn of lifecycle.cleanup.splice(0)) fn()
}

describeStatusAcrossSignIn(
  "createChannel",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = createChannel("public:task", () => undefined)
    return { status, error }
  },
  cleanup,
)

describe("createChannel's connection", () => {
  afterEach(() => {
    cleanup()
    lifecycle.harness?.restore()
  })

  it("tells a drop from a first connect, and leaves the channel on cleanup", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { isConnected, connectionState } = createChannel("auction:1", () => undefined)
    expect(connectionState()).toBe("connecting")
    await harness.settle()
    expect(connectionState()).toBe("connected")
    expect(isConnected()).toBe(true)

    harness.socket().onclose?.(closeEvent())
    expect(connectionState()).toBe("connecting")
    expect(isConnected()).toBe(false)

    cleanup()
    expect(harness.realtime.connectionState).toBe("disconnected")
  })
})
