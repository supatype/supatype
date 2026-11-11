/**
 * `useSubscription` returns the server's reason when it refuses the join.
 *
 * 0.9.2 release test (N-FF5): a join for a table that does not exist is refused, naming the table.
 * The hook only returned CHANNEL_ERROR, so a component could not say what was wrong.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { simulateServerMessage, subscribedChannels } from "../../client/tests/helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"

const shared = vi.hoisted(() => ({ harness: null as SocketSwapHarness | null }))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: shared.harness?.realtime }),
}))

import { useSubscription, type UseSubscriptionResult } from "../src/useSubscription.js"

const REASON = "table public.notes does not exist: check the table name and schema"

let renderer: ReactTestRenderer | null = null
let latest: UseSubscriptionResult | null = null

function Probe(): null {
  latest = useSubscription("notes:team", { table: "notes", callback: () => undefined })
  return null
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
  shared.harness?.restore()
})

describe("useSubscription's error", () => {
  it("is null while joining and joined, and the server's reason once refused", async () => {
    const harness = createSocketSwapHarness()
    shared.harness = harness
    act(() => {
      renderer = create(<Probe />)
    })
    await act(() => harness.settle())
    expect(latest?.error).toBeNull()

    const channel = subscribedChannels(harness.socket())[0]
    act(() => {
      simulateServerMessage(harness.socket(), { type: "system", status: "error", message: REASON, channel })
    })
    expect(latest?.status).toBe("CHANNEL_ERROR")
    expect(latest?.error?.message).toBe(REASON)
  })
})
