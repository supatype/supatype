/**
 * `createSubscription`'s status signal follows the realtime socket swap that signing in causes.
 *
 * It read "connected" from the moment the anon socket joined, through the swap, until well after
 * the signed-in socket had joined, because the swap reported nothing and the primitive ignored the
 * SUBSCRIBING it would have reported. An insert made in that window never arrived.
 *
 * `onMount` runs directly and `onCleanup` is collected: under Node, solid-js resolves to its server
 * build, where `onMount` never runs. What is under test is how the primitive wires the channel.
 */

import { vi } from "vitest"
import { describeStatusAcrossSignIn, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const lifecycle = vi.hoisted(() => ({ cleanup: [] as Array<() => void>, harness: null as SocketSwapHarness | null }))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => lifecycle.cleanup.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: lifecycle.harness?.realtime }),
}))

import { createSubscription } from "../src/createSubscription.js"

describeStatusAcrossSignIn(
  "createSubscription",
  (harness) => {
    lifecycle.harness = harness
    const { status, error } = createSubscription("task")
    return { status, error }
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
