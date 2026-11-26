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

import { vi, it, expect } from "vitest"
import { get } from "svelte/store"
import { describeStatusAcrossSignIn, createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { fakeClient } from "../../client/tests/helpers/fake-client.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, harness: null as SocketSwapHarness | null, client: null as unknown }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => lifecycle.client,
}))

import { createSubscription } from "../src/createSubscription.js"

describeStatusAcrossSignIn(
  "createSubscription",
  (harness) => {
    lifecycle.harness = harness
    lifecycle.client = fakeClient(harness).client
    const { status, error } = createSubscription("task")
    return { status: () => get(status), error: () => get(error) }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)

it("createSubscription shows the rows the table already holds once the join is acknowledged", async () => {
  const harness = createSocketSwapHarness()
  lifecycle.harness = harness
  lifecycle.client = fakeClient(harness, [[{ id: 1 }]]).client
  const { data } = createSubscription("task")
  await harness.settle()
  harness.ackJoins()
  await harness.settle()
  expect(get(data)).toEqual([{ id: 1 }])
  for (const fn of lifecycle.destroy.splice(0)) fn()
  harness.restore()
})
