/**
 * What a subscribe frame tells the server.
 *
 * The listener resolved `table` and `schema` and then dropped them building the frame, so the
 * server was left inferring the table from the channel name. That inference is right only when the
 * channel is named after its table, which is what `from(table).subscribe()` produces; a channel
 * named for its purpose matched nothing, and the socket reported SUBSCRIBED while delivering
 * nothing at all.
 *
 * Asserted on the wire rather than through a round trip, because the wire is where the loss
 * happened and a round trip against a fake server would only assert the fake.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RealtimeClient } from "../src/realtime.js"
import { createMockWebSocketClass, type MockWebSocketInstance } from "./helpers/mock-websocket.js"

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

let instances: MockWebSocketInstance[]
let originalWebSocket: typeof WebSocket

beforeEach(() => {
  const mock = createMockWebSocketClass()
  instances = mock.instances
  originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = mock.MockWebSocket
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  vi.restoreAllMocks()
})

/** Every subscribe frame the client put on the socket. */
function subscribeFrames(): Array<Record<string, unknown>> {
  return instances
    .flatMap((i) => i.send.mock.calls.map((c) => c[0] as string))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((m) => m["type"] === "subscribe")
}

describe("the subscribe frame", () => {
  it("names the table when the channel does not", async () => {
    const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
    client
      .channel("lobby-chat")
      .on("postgres_changes", { event: "INSERT", table: "chat_message" }, () => {})
      .subscribe()
    await settle()

    const frame = subscribeFrames()[0]
    expect(frame).toBeDefined()
    expect(frame!["channel"]).toBe("lobby-chat")
    // The assertion the bug failed: without this the server reads "lobby-chat" as the table.
    expect(frame!["table"]).toBe("chat_message")
    expect(frame!["schema"]).toBe("public")
  })

  it("carries the event and filter alongside it", async () => {
    const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
    client
      .channel("lobby-chat")
      .on(
        "postgres_changes",
        { event: "INSERT", table: "chat_message", filter: "room=eq.lobby" },
        () => {},
      )
      .subscribe()
    await settle()

    const frame = subscribeFrames()[0]!
    expect(frame["event"]).toBe("INSERT")
    expect(frame["filter"]).toEqual({ room: "eq.lobby" })
  })

  it("still names the table when the channel already matches it", async () => {
    // `from(table).subscribe()` names the channel after the table. That worked by coincidence
    // before; it should now be stated rather than inferred.
    const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
    client
      .channel("chat_message")
      .on("postgres_changes", { event: "*", table: "chat_message" }, () => {})
      .subscribe()
    await settle()

    expect(subscribeFrames()[0]!["table"]).toBe("chat_message")
  })

  it("falls back to the channel's own table when no table is given", async () => {
    // A channel written as `schema:table` still resolves, which is what the server's fallback
    // reads too. Neither side should have to guess, but both agree when they do.
    const client = new RealtimeClient("http://localhost:9999", { apikey: "anon" })
    client
      .channel("app:orders")
      .on("postgres_changes", { event: "*" }, () => {})
      .subscribe()
    await settle()

    expect(subscribeFrames()[0]!["table"]).toBe("orders")
  })
})
