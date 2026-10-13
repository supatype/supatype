/**
 * `createSubscription`'s status store follows the realtime socket swap that signing in causes.
 *
 * It read "connected" from the moment the anon socket joined, through the swap, until well after
 * the signed-in socket had joined, because the swap reported nothing and the store ignored the
 * SUBSCRIBING it would have reported. An insert made in that window never arrived.
 *
 * `onDestroy` is collected rather than registered with a component: what is under test is how the
 * store wires the channel, not Svelte's component lifecycle.
 */

import { vi } from "vitest"
import { get } from "svelte/store"
import { describeStatusAcrossSignIn, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createSubscription } from "../src/createSubscription.js"

describeStatusAcrossSignIn(
  "createSubscription",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = createSubscription("task")
    return { status: () => get(status), error: () => get(error) }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
