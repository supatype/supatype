/**
 * A refused join hands the status callback the server's reason, as `(status, err)`.
 *
 * 0.9.2 release test (N-FF5): the server now refuses a join for a table that does not exist, and
 * says which table. The client reported CHANNEL_ERROR and dropped the reason, so the bindings could
 * only say "Subscription error" and the developer had to read the socket's frames to find the typo.
 * The callback's second argument is how Supabase's client reports it too, so an existing
 * `(status) => ...` callback is unaffected.
 */

import { describe, it, expect, afterEach } from "vitest"
import type { ChannelStatus } from "../src/realtime.js"
import { subscriptionViewOf, watchTable, type SubscriptionView } from "../src/table-subscription.js"
import { simulateServerMessage, subscribedChannels } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

const REASON = "table public.notes does not exist: check the table name and schema"

let harness: SocketSwapHarness

afterEach(() => harness.restore())

/** The server refuses the newest socket's first join, naming its channel, with {@link REASON}. */
function refuseFirstJoin(): void {
  const channel = subscribedChannels(harness.socket())[0]
  simulateServerMessage(harness.socket(), { type: "system", status: "error", message: REASON, channel, ref: "1" })
}

describe("a refused join", () => {
  it("passes the server's message to the status callback as an Error", async () => {
    harness = createSocketSwapHarness()
    const seen: Array<{ status: ChannelStatus; err: Error | undefined }> = []
    harness.realtime
      .channel("notes:team")
      .on("postgres_changes", { event: "*", table: "notes" }, () => {})
      .subscribe((status, err) => seen.push({ status, err }))
    await harness.settle()
    refuseFirstJoin()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.status).toBe("CHANNEL_ERROR")
    expect(seen[0]?.err).toBeInstanceOf(Error)
    expect(seen[0]?.err?.message).toBe(REASON)
  })

  it("passes no error with any other status", async () => {
    harness = createSocketSwapHarness()
    const errs: Array<Error | undefined> = []
    harness.realtime
      .channel("notes:ok")
      .on("postgres_changes", { event: "*", table: "note" }, () => {})
      .subscribe((_status, err) => errs.push(err))
    await harness.settle()
    harness.ackJoins()

    expect(errs).toEqual([undefined])
  })

  it("reaches the bindings' view as the error message", async () => {
    harness = createSocketSwapHarness()
    const views: SubscriptionView[] = []
    const stop = watchTable(harness.realtime, "notes", undefined, {
      rows: () => undefined,
      status: (view) => views.push(view),
    })
    await harness.settle()
    refuseFirstJoin()
    stop()

    expect(views.map((view) => view.error?.message)).toEqual([REASON])
  })
})

describe("subscriptionViewOf with an error", () => {
  it("shows the error's message, and the old wording when there is none", () => {
    expect(subscriptionViewOf("CHANNEL_ERROR", new Error(REASON)).error?.message).toBe(REASON)
    expect(subscriptionViewOf("CHANNEL_ERROR").error?.message).toBe("Subscription error")
  })
})
