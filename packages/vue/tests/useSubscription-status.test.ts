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

import { vi, it, expect } from "vitest"
import { describeStatusAcrossSignIn, createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { fakeClient } from "../../client/tests/helpers/fake-client.js"

const lifecycle = vi.hoisted(() => ({ unmount: [] as Array<() => void>, harness: null as SocketSwapHarness | null, client: null as unknown }))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { useSubscription } from "../src/useSubscription.js"

describeStatusAcrossSignIn(
  "useSubscription",
  (harness) => {
    lifecycle.harness = harness
    lifecycle.client = fakeClient(harness).client
    const { status, error } = useSubscription("task")
    return { status: () => status.value, error: () => error.value }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)

it("useSubscription shows the rows the table already holds once the join is acknowledged", async () => {
  const harness = createSocketSwapHarness()
  lifecycle.harness = harness
  lifecycle.client = fakeClient(harness, [[{ id: 1 }]]).client
  const { data } = useSubscription("task")
  await harness.settle()
  harness.ackJoins()
  await harness.settle()
  expect(data.value).toEqual([{ id: 1 }])
  for (const fn of lifecycle.unmount.splice(0)) fn()
  harness.restore()
})
