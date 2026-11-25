/**
 * `createChannel` and `createRealtimeConnection`: the status across the sign-in swap, and the
 * socket's own state through a drop. `onDestroy` is collected, as in the `createSubscription` suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { get } from "svelte/store"
import { closeEvent } from "../../client/tests/helpers/close-event.js"
import { describeStatusAcrossSignIn, createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createChannel } from "../src/createChannel.js"

const destroy = (): void => {
  for (const fn of lifecycle.destroy.splice(0)) fn()
}

describeStatusAcrossSignIn(
  "createChannel",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = createChannel("public:task", () => undefined)
    return { status: () => get(status), error: () => get(error) }
  },
  destroy,
)

describe("createChannel's connection", () => {
  afterEach(() => {
    destroy()
    lifecycle.harness?.restore()
  })

  it("tells a drop from a first connect, and leaves the channel on destroy", async () => {
    const harness = createSocketSwapHarness()
    lifecycle.harness = harness
    const { isConnected, connectionState } = createChannel("auction:1", () => undefined)
    expect(get(connectionState)).toBe("connecting")
    await harness.settle()
    expect(get(connectionState)).toBe("connected")
    expect(get(isConnected)).toBe(true)

    harness.socket().onclose?.(closeEvent())
    expect(get(connectionState)).toBe("connecting")
    expect(get(isConnected)).toBe(false)

    destroy()
    expect(harness.realtime.connectionState).toBe("disconnected")
  })
})
