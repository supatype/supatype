/**
 * `useSubscription`'s status follows the realtime socket swap that signing in causes.
 *
 * It read "connected" from the moment the anon socket joined, through the swap, until well after
 * the signed-in socket had joined, because the swap reported nothing and the composable ignored
 * the SUBSCRIBING it would have reported. An insert made in that window never arrived.
 *
 * The lifecycle hooks run directly: what is under test is how the composable wires the channel,
 * not Vue's mounting.
 */

import { vi } from "vitest"
import { describeStatusAcrossSignIn, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const lifecycle = vi.hoisted(() => ({ unmount: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { useSubscription } from "../src/useSubscription.js"

describeStatusAcrossSignIn(
  "useSubscription",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = useSubscription("task")
    return { status: () => status.value, error: () => error.value }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
