/**
 * `from(table).subscribe()` on its own delivers changes.
 *
 * It registered a listener and returned, and never joined the channel: `on()` only records a
 * listener, and the socket and the subscribe frame belong to the channel's own `subscribe()`. So a
 * caller who used the documented typed API, and nothing else, waited for events that never came.
 * It looked fine whenever something else on the same client had already subscribed a channel of
 * the same name, because the two shared that channel's state.
 *
 * Every case here uses a client with no other subscription, which is the case the bug hid in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createClient } from "../src/index.js"
import type { RealtimePayload } from "../src/realtime.js"
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

function newClient(): ReturnType<typeof createClient> {
  return createClient({ url: "http://localhost:18473", anonKey: "anon-key" })
}

/** Every frame the client put on any socket, parsed. */
function sentFrames(): Array<Record<string, unknown>> {
  return instances
    .flatMap((i) => i.send.mock.calls.map((c) => c[0] as string))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
}

function framesOfType(type: string): Array<Record<string, unknown>> {
  return sentFrames().filter((m) => m["type"] === type)
}

/** The only socket opened so far. A second one would mean a subscribe orphaned the first. */
function onlySocket(): MockWebSocketInstance {
  expect(instances).toHaveLength(1)
  return instances[0]!
}

/** A change frame as the service sends one, addressed to the channel the client subscribed. */
function changeOn(
  channel: string,
  event: "INSERT" | "UPDATE" | "DELETE",
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "change",
    channel,
    event,
    payload: { old: null, new: row },
    timestamp: "2026-01-01T00:00:00Z",
  }
}

function ack(channel: string): Record<string, unknown> {
  return { type: "system", status: "ok", message: `subscribed to ${channel}` }
}

describe("from(table).subscribe() alone", () => {
  it("opens a socket, sends the subscribe frame, and delivers a change", async () => {
    const client = newClient()
    const seen: Array<RealtimePayload<Record<string, unknown>>> = []

    client.from("post").subscribe((payload) => seen.push(payload))
    await settle()

    const ws = onlySocket()
    const frames = framesOfType("subscribe")
    expect(frames).toHaveLength(1)
    const frame = frames[0]!
    expect(frame["table"]).toBe("post")
    expect(frame["schema"]).toBe("public")
    expect(frame["event"]).toBe("*")

    simulateServerMessage(ws, changeOn(frame["channel"] as string, "INSERT", { id: 1 }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.eventType).toBe("INSERT")
    expect(seen[0]!.table).toBe("post")
    expect(seen[0]!.schema).toBe("public")
    expect(seen[0]!.new).toEqual({ id: 1 })
  })

  it("sends the filter and event to the server, and drops other events", async () => {
    const client = newClient()
    const seen: Array<RealtimePayload<Record<string, unknown>>> = []

    client
      .from("post")
      .subscribe((payload) => seen.push(payload), { event: "INSERT", filter: "slug=eq.hello" })
    await settle()

    const ws = onlySocket()
    const frame = framesOfType("subscribe")[0]!
    // The server applies the filter; the client only has to have said it.
    expect(frame["filter"]).toEqual({ slug: "eq.hello" })
    expect(frame["event"]).toBe("INSERT")

    const channel = frame["channel"] as string
    simulateServerMessage(ws, changeOn(channel, "UPDATE", { id: 1 }))
    simulateServerMessage(ws, changeOn(channel, "INSERT", { id: 2 }))
    expect(seen.map((p) => p.new)).toEqual([{ id: 2 }])
  })

  it("honours a non-default schema", async () => {
    const client = newClient()
    client.from("post").subscribe(() => {}, { schema: "app" })
    await settle()

    const frame = framesOfType("subscribe")[0]!
    expect(frame["schema"]).toBe("app")
    expect(frame["table"]).toBe("post")
  })

  it("closes the socket when its only subscription unsubscribes", async () => {
    const client = newClient()
    const sub = client.from("post").subscribe(() => {})
    await settle()

    const ws = onlySocket()
    const channel = framesOfType("subscribe")[0]!["channel"]
    sub.unsubscribe()

    expect(framesOfType("unsubscribe")).toEqual([{ type: "unsubscribe", channel }])
    expect(ws.close).toHaveBeenCalled()
  })
})

describe("the status callback on the returned channel", () => {
  it("still reports SUBSCRIBED without sending a second subscribe frame", async () => {
    // The examples call `sub.channel.subscribe(cb)` to watch status, because that call used to be
    // the only thing that joined. It has to keep working, and must not join twice.
    const client = newClient()
    const statuses: string[] = []

    const sub = client.from("post").subscribe(() => {})
    sub.channel.subscribe((s) => statuses.push(s))
    await settle()

    const ws = onlySocket()
    const frames = framesOfType("subscribe")
    expect(frames).toHaveLength(1)
    simulateServerMessage(ws, ack(frames[0]!["channel"] as string))
    expect(statuses).toEqual(["SUBSCRIBED"])
  })

  it("is told SUBSCRIBED when attached after the join was acknowledged", async () => {
    // No second acknowledgement is coming, so a callback attached late would otherwise wait on
    // nothing. Re-sending the frame to provoke one is the double join the case above forbids.
    const client = newClient()
    const sub = client.from("post").subscribe(() => {})
    await settle()

    const ws = onlySocket()
    simulateServerMessage(ws, ack(framesOfType("subscribe")[0]!["channel"] as string))

    const statuses: string[] = []
    sub.channel.subscribe((s) => statuses.push(s))
    expect(statuses).toEqual(["SUBSCRIBED"])
    expect(framesOfType("subscribe")).toHaveLength(1)
  })
})

describe("two subscriptions to the same table on one client", () => {
  it("each joins with its own filter and receives its own events", async () => {
    const client = newClient()
    const first: unknown[] = []
    const second: unknown[] = []

    client.from("post").subscribe((p) => first.push(p.new), { filter: "slug=eq.a" })
    client.from("post").subscribe((p) => second.push(p.new), { filter: "slug=eq.b" })
    await settle()

    const ws = onlySocket()
    const frames = framesOfType("subscribe")
    expect(frames).toHaveLength(2)
    expect(frames.map((f) => f["filter"])).toEqual([{ slug: "eq.a" }, { slug: "eq.b" }])
    // Distinct channels, because the server keys a subscription by its channel: a second join
    // under the same name would replace the first one's filter rather than add to it.
    expect(frames[0]!["channel"]).not.toBe(frames[1]!["channel"])

    // The server addresses each change to the subscription it matched.
    simulateServerMessage(ws, changeOn(frames[0]!["channel"] as string, "INSERT", { slug: "a" }))
    simulateServerMessage(ws, changeOn(frames[1]!["channel"] as string, "INSERT", { slug: "b" }))
    expect(first).toEqual([{ slug: "a" }])
    expect(second).toEqual([{ slug: "b" }])
  })

  it("unsubscribing one leaves the other delivering on the same socket", async () => {
    const client = newClient()
    const second: unknown[] = []

    const a = client.from("post").subscribe(() => {})
    client.from("post").subscribe((p) => second.push(p.new))
    await settle()

    const ws = onlySocket()
    const [frameA, frameB] = framesOfType("subscribe")
    a.unsubscribe()

    expect(framesOfType("unsubscribe")).toEqual([
      { type: "unsubscribe", channel: frameA!["channel"] },
    ])
    expect(ws.close).not.toHaveBeenCalled()
    simulateServerMessage(ws, changeOn(frameB!["channel"] as string, "INSERT", { id: 7 }))
    expect(second).toEqual([{ id: 7 }])
  })

  it("does not share state with a raw channel named after the table", async () => {
    // The raw channel is what used to hide the bug: it joined, and the table subscription rode on
    // its state. Unsubscribing either must not tear down the other.
    const client = newClient()
    const fromTable: unknown[] = []

    const raw = client.realtime
      .channel("public:post")
      .on("postgres_changes", { event: "*" }, () => {})
      .subscribe()
    const sub = client.from("post").subscribe((p) => fromTable.push(p.new))
    await settle()

    const ws = onlySocket()
    const frames = framesOfType("subscribe")
    expect(frames).toHaveLength(2)
    const tableChannel = frames.find((f) => f["channel"] !== "public:post")!["channel"] as string

    raw.unsubscribe()
    expect(ws.close).not.toHaveBeenCalled()
    simulateServerMessage(ws, changeOn(tableChannel, "INSERT", { id: 3 }))
    expect(fromTable).toEqual([{ id: 3 }])
    sub.unsubscribe()
    expect(ws.close).toHaveBeenCalled()
  })
})
