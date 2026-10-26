/**
 * `useSubscription`'s status follows the realtime socket swap that signing in causes.
 *
 * The hook passes the channel's own status through, so it was only as right as the client: the
 * swap reported nothing, and the hook read SUBSCRIBED from the moment the anon socket joined until
 * well after the signed-in socket had joined. An insert made in that window never arrived.
 */

import React from "react"
import { vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describeStatusAcrossSignIn, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const shared = vi.hoisted(() => ({ harness: null as SocketSwapHarness | null }))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: shared.harness?.realtime }),
}))

import { useSubscription, type SubscriptionStatus } from "../src/useSubscription.js"

let renderer: ReactTestRenderer | null = null
let latest: SubscriptionStatus | null = null

function Probe(): null {
  latest = useSubscription("public:task", { table: "task", callback: () => undefined }).status
  return null
}

describeStatusAcrossSignIn(
  "useSubscription",
  (harness) => {
    shared.harness = harness
    act(() => {
      renderer = create(<Probe />)
    })
    return { status: () => latest ?? "unrendered" }
  },
  () => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
  },
  {
    swap: ["SUBSCRIBING", "SUBSCRIBED", "SUBSCRIBING", "SUBSCRIBED"],
    refused: ["SUBSCRIBING", "SUBSCRIBED", "SUBSCRIBING", "CHANNEL_ERROR"],
  },
)
