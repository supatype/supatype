/**
 * The rows a table subscription keeps: seeded from a read, upserted by key, and read again after a
 * drop.
 *
 * `watchTable` started from an empty list and never read the table, and matched on `id` only for an
 * update or a delete. So an UPDATE or DELETE of a row that existed before the subscription did
 * nothing, an INSERT delivered twice listed the row twice, and anything changed while the socket was
 * down was lost for good.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyRowChange, watchTable } from "../src/bindings.js"
import type { RealtimePayload } from "../src/index.js"
import { closeEvent, simulateServerMessage, subscribedChannels } from "./helpers/mock-websocket.js"
import { fakeClient } from "./helpers/fake-client.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

interface Row {
  id: number
  /** Absent on an old row when the table only replicates its key. */
  v?: string
}

const change = (eventType: RealtimePayload<Row>["eventType"], row: Row | null, old: Row | null = null): RealtimePayload<Row> => ({
  eventType,
  new: row,
  old,
  schema: "public",
  table: "task",
  commitTimestamp: "2024-01-01T00:00:00Z",
})

describe("applyRowChange", () => {
  it("adds the row of an UPDATE to a row it has not seen", () => {
    expect(applyRowChange<Row>(null, change("UPDATE", { id: 1, v: "b" }, { id: 1 }))).toEqual([{ id: 1, v: "b" }])
  })

  it("lists a row once when its INSERT arrives twice, keeping the later one", () => {
    const once = applyRowChange<Row>(null, change("INSERT", { id: 1, v: "a" }))
    expect(applyRowChange(once, change("INSERT", { id: 1, v: "b" }))).toEqual([{ id: 1, v: "b" }])
  })

  it("leaves the rows alone for a DELETE of a row it has not seen", () => {
    const rows = [{ id: 2, v: "x" }]
    expect(applyRowChange(rows, change("DELETE", null, { id: 1 }))).toEqual(rows)
  })

  it("removes the row a DELETE names by its key", () => {
    expect(applyRowChange([{ id: 1, v: "a" }, { id: 2, v: "b" }], change("DELETE", null, { id: 1 }))).toEqual([{ id: 2, v: "b" }])
  })

  it("matches on the key columns it is given, a composite one included", () => {
    const rows = [{ org: 1, user: 1, role: "a" }, { org: 1, user: 2, role: "a" }]
    const update: RealtimePayload<(typeof rows)[number]> = {
      ...change("UPDATE", null),
      new: { org: 1, user: 2, role: "b" },
      old: { org: 1, user: 2, role: "a" },
    }
    expect(applyRowChange(rows, update, ["org", "user"])).toEqual([rows[0], { org: 1, user: 2, role: "b" }])
  })
})

let harness: SocketSwapHarness
beforeEach(() => {
  harness = createSocketSwapHarness()
})
afterEach(() => harness.restore())

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

function watch(reads: Row[][], filter?: string): { seen: Row[][]; stop: () => void; filters: string[][] } {
  const { client, filters } = fakeClient<Row>(harness, reads)
  const seen: Row[][] = []
  const stop = watchTable<Row>(client, "task", filter === undefined ? undefined : { filter }, {
    rows: (rows) => seen.push(rows),
    status: () => undefined,
  })
  return { seen, stop, filters }
}

describe("watchTable seeds its rows", () => {
  it("reads the table once the join is acknowledged and shows those rows", async () => {
    const { seen } = watch([[{ id: 1, v: "a" }]])
    await harness.settle()
    expect(seen).toEqual([])

    harness.ackJoins()
    await tick()
    expect(seen).toEqual([[{ id: 1, v: "a" }]])
  })

  it("applies the subscription's filter to that read", async () => {
    const { filters } = watch([[]], "room_id=eq.7,score=gte.10")
    await harness.settle()
    harness.ackJoins()
    await tick()

    expect(filters[0]).toEqual(["room_id eq 7", "score gte 10"])
  })

  it("updates a row that existed before it subscribed", async () => {
    const { seen } = watch([[{ id: 1, v: "a" }]])
    await harness.settle()
    harness.ackJoins()
    await tick()

    simulateServerMessage(harness.socket(), {
      type: "change",
      channel: subscribedChannels(harness.socket())[0],
      event: "UPDATE",
      payload: { old: { id: 1 }, new: { id: 1, v: "b" } },
      timestamp: "2024-01-01T00:00:00Z",
    })

    expect(seen[seen.length - 1]).toEqual([{ id: 1, v: "b" }])
  })
})

describe("watchTable after a drop", () => {
  it("reads the table again once the join is back, so a change made while down shows up", async () => {
    const { seen } = watch([[{ id: 1, v: "a" }], [{ id: 1, v: "changed while down" }]])
    await harness.settle()
    harness.ackJoins()
    await tick()
    expect(seen[seen.length - 1]).toEqual([{ id: 1, v: "a" }])

    harness.socket().onclose?.(closeEvent())
    const before = harness.sockets.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(harness.sockets.length).toBe(before + 1)
    harness.ackJoins()
    await tick()

    expect(seen[seen.length - 1]).toEqual([{ id: 1, v: "changed while down" }])
  })
})
