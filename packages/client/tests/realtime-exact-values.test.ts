/**
 * The same row, read two ways, holding the same values.
 *
 * A row read over REST goes through `parseRowsExactly`, so a `bigInt` column arrives as a native
 * bigint and a `decimal` as its exact string. The same row arriving over a subscription used to be
 * a rounded number, because the realtime path had none of that: the service parsed the WAL with a
 * plain `JSON.parse` and the client parsed the frame with another.
 *
 * The service now carries exact columns as strings and says which they are, reading the kinds from
 * the database's own declared types. That is why the frames below name `exactColumns`, and why the
 * client does not consult the local registry here: the frame is authoritative, so a project that
 * never ran `supatype push` still reads the value correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RealtimeClient } from "../src/realtime.js"
import {
  createMockWebSocketClass,
  simulateServerMessage,
  type MockWebSocketInstance,
} from "./helpers/mock-websocket.js"

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

let instances: MockWebSocketInstance[]

beforeEach(() => {
  const mock = createMockWebSocketClass()
  instances = mock.instances
  vi.stubGlobal("WebSocket", mock.MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Subscribe to a table, deliver one change frame, and hand back what the listener was given. */
async function deliver(frame: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
  let seen: Record<string, unknown> | null = null

  client
    .channel("public:subscription")
    .on("postgres_changes", { event: "INSERT" }, (payload) => {
      seen = payload.new
    })
    .subscribe()

  await settle()
  const ws = instances[0]
  if (!ws) throw new Error("no socket was opened")
  simulateServerMessage(ws, frame)
  await settle()
  return seen
}

/** A change frame as the service now sends one: exact columns as strings, and named. */
function changeFrame(
  row: Record<string, unknown>,
  exactColumns?: Record<string, string>,
): Record<string, unknown> {
  return {
    type: "change",
    channel: "public:subscription",
    event: "INSERT",
    payload: { old: null, new: row },
    ...(exactColumns ? { exactColumns } : {}),
    timestamp: "2026-01-01T00:00:00Z",
  }
}

describe("a change carrying exact columns", () => {
  it("gives a bigint column a native bigint", async () => {
    const row = await deliver(
      changeFrame({ id: "a", externalId: "9007199254740993" }, { externalId: "bigint" }),
    )
    expect(row?.["externalId"]).toBe(9007199254740993n)
  })

  it("keeps the value a double would have rounded", async () => {
    // The control that names the defect. It cannot be written as a numeric literal, because a
    // literal of 9007199254740993 in this file is already 9007199254740992 by the time it runs:
    // that is the whole problem. So the rounded value is derived, and the delivered one compared
    // against it.
    const rounded = BigInt(Number("9007199254740993"))
    expect(rounded).toBe(9007199254740992n)

    const row = await deliver(
      changeFrame({ id: "a", externalId: "9007199254740993" }, { externalId: "bigint" }),
    )
    expect(row?.["externalId"]).not.toBe(rounded)
    expect(String(row?.["externalId"])).toBe("9007199254740993")
  })

  it("leaves a numeric column as its exact string, scale and all", async () => {
    // `@supatype/types` declares Decimal and Money as string, because JavaScript has no exact
    // decimal. 10.00 and 10 are the same number and different values.
    const row = await deliver(changeFrame({ unitAmount: "10.00" }, { unitAmount: "numeric" }))
    expect(row?.["unitAmount"]).toBe("10.00")
  })

  it("touches nothing the frame did not name", async () => {
    const row = await deliver(
      changeFrame(
        { id: "a", quantity: 42, title: "unchanged", externalId: "12" },
        { externalId: "bigint" },
      ),
    )
    expect(row?.["quantity"]).toBe(42)
    expect(row?.["title"]).toBe("unchanged")
  })

  it("coerces a small bigint too, because the database declared it one", async () => {
    // Not decided by whether the value happens to be large: a column typed bigint reads as a
    // bigint every time, or an application comparing against one is wrong half the time.
    const row = await deliver(changeFrame({ externalId: "12" }, { externalId: "bigint" }))
    expect(row?.["externalId"]).toBe(12n)
  })

  it("applies the same coercion to the old record of an update", async () => {
    const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
    let old: Record<string, unknown> | null = null
    client
      .channel("public:subscription")
      .on("postgres_changes", { event: "UPDATE" }, (payload) => {
        old = payload.old
      })
      .subscribe()
    await settle()
    const ws = instances[0]
    if (!ws) throw new Error("no socket was opened")
    simulateServerMessage(ws, {
      type: "change",
      channel: "public:subscription",
      event: "UPDATE",
      payload: { old: { externalId: "9007199254740993" }, new: { externalId: "9007199254740995" } },
      exactColumns: { externalId: "bigint" },
      timestamp: "2026-01-01T00:00:00Z",
    })
    await settle()
    expect(old?.["externalId"]).toBe(9007199254740993n)
  })
})

describe("a change from a table with nothing exact", () => {
  it("arrives unchanged when the frame names no exact columns", async () => {
    // Which is most tables, and the frame carries no extra field for them at all.
    const row = await deliver(changeFrame({ id: "a", views: 3, title: "hello" }))
    expect(row).toEqual({ id: "a", views: 3, title: "hello" })
  })

  it("survives a frame from a service too old to send the field", async () => {
    // An upgrade puts a new client in front of an old service. The values are already rounded by
    // then and nothing here can recover them, but the payload must still be delivered.
    const row = await deliver(changeFrame({ id: "a", externalId: 9007199254740992 }))
    expect(row?.["id"]).toBe("a")
    expect(row?.["externalId"]).toBe(9007199254740992)
  })
})

describe("a change carrying array columns of exact values", () => {
  it("gives a bigint[] column native bigints, past 2^53 and nested", async () => {
    const row = await deliver(
      changeFrame(
        { ids: ["9007199254740993", "1", null], grid: [["1", "9007199254740995"]] },
        { ids: "bigint[]", grid: "bigint[]" },
      ),
    )
    expect(row?.["ids"]).toEqual([9007199254740993n, 1n, null])
    expect(row?.["grid"]).toEqual([[1n, 9007199254740995n]])
  })

  it("leaves a numeric[] as exact strings", async () => {
    const row = await deliver(changeFrame({ rates: ["1.10", "2.500"] }, { rates: "numeric[]" }))
    expect(row?.["rates"]).toEqual(["1.10", "2.500"])
  })
})

describe("a change naming a kind this client does not know", () => {
  it("delivers the frame with the unknown column as sent", async () => {
    // A newer service can name a kind this client predates. Dropping the whole frame would lose a
    // change over one column, so the kind is ignored and the value passes through untouched.
    const row = await deliver(
      changeFrame({ id: "a", tag: "9007199254740993" }, { tag: "quantum" }),
    )
    expect(row).toEqual({ id: "a", tag: "9007199254740993" })
  })

  it("still coerces the kinds it knows in the same frame", async () => {
    const row = await deliver(
      changeFrame(
        { id: "a", externalId: "9007199254740993", ids: ["1", "2"], rates: ["1.10"], tag: "x" },
        { externalId: "bigint", ids: "bigint[]", rates: "numeric[]", tag: "uuid[]" },
      ),
    )
    expect(row?.["externalId"]).toBe(9007199254740993n)
    expect(row?.["ids"]).toEqual([1n, 2n])
    expect(row?.["rates"]).toEqual(["1.10"])
    expect(row?.["tag"]).toBe("x")
  })
})
