/**
 * Integration test — Task 94: Realtime multi-tenant isolation
 *
 * Tests: subscribe to project A -> insert in A -> event received ->
 * insert in B -> no event on A's subscription.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RealtimeClient, type RealtimePayload } from "../src/realtime.js"

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

interface MockWebSocketInstance {
  url: string
  readyState: number
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function createMockWebSocketClass() {
  const instances: MockWebSocketInstance[] = []

  class MockWebSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3

    url: string
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    send = vi.fn()
    close = vi.fn()

    constructor(url: string) {
      this.url = url
      instances.push(this as unknown as MockWebSocketInstance)

      // Auto-open after a microtask
      queueMicrotask(() => {
        this.readyState = 1 // OPEN
        this.onopen?.({} as Event)
      })
    }
  }

  return { MockWebSocket, instances }
}

/** Simulate a server message arriving on a WebSocket instance. */
function simulateServerMessage(ws: MockWebSocketInstance, msg: Record<string, unknown>): void {
  ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task 94 — Realtime multi-tenant isolation", () => {
  let MockWS: ReturnType<typeof createMockWebSocketClass>

  beforeEach(() => {
    vi.restoreAllMocks()
    MockWS = createMockWebSocketClass()
    vi.stubGlobal("WebSocket", MockWS.MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("Single tenant subscription", () => {
    it("receives INSERT events on the subscribed channel", async () => {
      const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "anon-key-A" })
      const received: RealtimePayload<Record<string, unknown>>[] = []

      client
        .channel<Record<string, unknown>>("public:posts")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, (payload) => {
          received.push(payload)
        })
        .subscribe()

      // Wait for WebSocket to open
      await new Promise((resolve) => setTimeout(resolve, 10))

      const ws = MockWS.instances[0]!

      // Simulate server confirming subscription
      simulateServerMessage(ws, {
        type: "system",
        status: "ok",
        message: "subscribed to public:posts",
      })

      // Simulate an INSERT event
      simulateServerMessage(ws, {
        type: "change",
        channel: "public:posts",
        event: "INSERT",
        payload: {
          new: { id: 1, title: "Hello from project A", author_id: "user-1" },
          old: null,
        },
        timestamp: "2024-01-01T00:00:00Z",
      })

      expect(received).toHaveLength(1)
      expect(received[0]!.eventType).toBe("INSERT")
      expect(received[0]!.new).toEqual({ id: 1, title: "Hello from project A", author_id: "user-1" })
    })
  })

  describe("Multi-tenant isolation", () => {
    it("project A subscription does NOT receive project B events", async () => {
      // Project A client
      const clientA = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "anon-key-project-A" })
      const receivedA: RealtimePayload<Record<string, unknown>>[] = []

      clientA
        .channel<Record<string, unknown>>("projectA:posts")
        .on("postgres_changes", { event: "*", schema: "projectA", table: "posts" }, (payload) => {
          receivedA.push(payload)
        })
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))
      const wsA = MockWS.instances[0]!

      // Confirm subscription for project A
      simulateServerMessage(wsA, {
        type: "system",
        status: "ok",
        message: "subscribed to projectA:posts",
      })

      // Simulate INSERT in project A's channel
      simulateServerMessage(wsA, {
        type: "change",
        channel: "projectA:posts",
        event: "INSERT",
        payload: {
          new: { id: 1, title: "Project A post" },
          old: null,
        },
        timestamp: "2024-01-01T00:00:01Z",
      })

      // Now simulate a message from project B arriving on the same WebSocket
      // (this would be the server-side routing — in a real system, the server
      // would NOT route project B events to project A's connection)
      simulateServerMessage(wsA, {
        type: "change",
        channel: "projectB:posts",   // Different channel
        event: "INSERT",
        payload: {
          new: { id: 99, title: "Project B post — should not be received" },
          old: null,
        },
        timestamp: "2024-01-01T00:00:02Z",
      })

      // Only project A's event should be received
      expect(receivedA).toHaveLength(1)
      expect(receivedA[0]!.new).toEqual({ id: 1, title: "Project A post" })
    })

    it("two independent clients receive only their own events", async () => {
      // Project A
      const clientA = new RealtimeClient("ws://a.realtime.test", { apikey: "key-A" })
      const eventsA: RealtimePayload<Record<string, unknown>>[] = []
      clientA
        .channel<Record<string, unknown>>("public:todos")
        .on("postgres_changes", { event: "INSERT" }, (p) => eventsA.push(p))
        .subscribe()

      // Project B
      const clientB = new RealtimeClient("ws://b.realtime.test", { apikey: "key-B" })
      const eventsB: RealtimePayload<Record<string, unknown>>[] = []
      clientB
        .channel<Record<string, unknown>>("public:todos")
        .on("postgres_changes", { event: "INSERT" }, (p) => eventsB.push(p))
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))

      const wsA = MockWS.instances[0]!
      const wsB = MockWS.instances[1]!

      // Confirm subscriptions
      simulateServerMessage(wsA, { type: "system", status: "ok", message: "subscribed to public:todos" })
      simulateServerMessage(wsB, { type: "system", status: "ok", message: "subscribed to public:todos" })

      // Insert in A
      simulateServerMessage(wsA, {
        type: "change",
        channel: "public:todos",
        event: "INSERT",
        payload: { new: { id: 1, text: "A's todo" }, old: null },
        timestamp: "t1",
      })

      // Insert in B
      simulateServerMessage(wsB, {
        type: "change",
        channel: "public:todos",
        event: "INSERT",
        payload: { new: { id: 2, text: "B's todo" }, old: null },
        timestamp: "t2",
      })

      // A only sees A's event, B only sees B's event
      expect(eventsA).toHaveLength(1)
      expect(eventsA[0]!.new).toEqual({ id: 1, text: "A's todo" })

      expect(eventsB).toHaveLength(1)
      expect(eventsB[0]!.new).toEqual({ id: 2, text: "B's todo" })
    })
  })

  describe("Channel matching", () => {
    it("events are dispatched to the correct channel only", async () => {
      const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "key" })
      const postsEvents: RealtimePayload<Record<string, unknown>>[] = []
      const commentsEvents: RealtimePayload<Record<string, unknown>>[] = []

      client
        .channel<Record<string, unknown>>("public:posts")
        .on("postgres_changes", { event: "*" }, (p) => postsEvents.push(p))
        .subscribe()

      client
        .channel<Record<string, unknown>>("public:comments")
        .on("postgres_changes", { event: "*" }, (p) => commentsEvents.push(p))
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))
      const ws = MockWS.instances[0]!

      // Confirm both
      simulateServerMessage(ws, { type: "system", status: "ok", message: "subscribed to public:posts" })
      simulateServerMessage(ws, { type: "system", status: "ok", message: "subscribed to public:comments" })

      // Insert into posts
      simulateServerMessage(ws, {
        type: "change",
        channel: "public:posts",
        event: "INSERT",
        payload: { new: { id: 1 }, old: null },
        timestamp: "t1",
      })

      // Insert into comments
      simulateServerMessage(ws, {
        type: "change",
        channel: "public:comments",
        event: "INSERT",
        payload: { new: { id: 100, post_id: 1 }, old: null },
        timestamp: "t2",
      })

      expect(postsEvents).toHaveLength(1)
      expect(postsEvents[0]!.new).toEqual({ id: 1 })

      expect(commentsEvents).toHaveLength(1)
      expect(commentsEvents[0]!.new).toEqual({ id: 100, post_id: 1 })
    })

    it("event type filtering: INSERT listener ignores UPDATE events", async () => {
      const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "key" })
      const inserts: RealtimePayload<Record<string, unknown>>[] = []

      client
        .channel<Record<string, unknown>>("public:posts")
        .on("postgres_changes", { event: "INSERT" }, (p) => inserts.push(p))
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))
      const ws = MockWS.instances[0]!
      simulateServerMessage(ws, { type: "system", status: "ok", message: "subscribed to public:posts" })

      // Send UPDATE
      simulateServerMessage(ws, {
        type: "change",
        channel: "public:posts",
        event: "UPDATE",
        payload: { new: { id: 1, title: "updated" }, old: { id: 1, title: "original" } },
        timestamp: "t1",
      })

      // Send INSERT
      simulateServerMessage(ws, {
        type: "change",
        channel: "public:posts",
        event: "INSERT",
        payload: { new: { id: 2, title: "new post" }, old: null },
        timestamp: "t2",
      })

      expect(inserts).toHaveLength(1)
      expect(inserts[0]!.eventType).toBe("INSERT")
    })

    it("wildcard (*) listener receives all event types", async () => {
      const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "key" })
      const allEvents: RealtimePayload<Record<string, unknown>>[] = []

      client
        .channel<Record<string, unknown>>("public:posts")
        .on("postgres_changes", { event: "*" }, (p) => allEvents.push(p))
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))
      const ws = MockWS.instances[0]!
      simulateServerMessage(ws, { type: "system", status: "ok", message: "subscribed to public:posts" })

      simulateServerMessage(ws, {
        type: "change", channel: "public:posts", event: "INSERT",
        payload: { new: { id: 1 }, old: null }, timestamp: "t1",
      })
      simulateServerMessage(ws, {
        type: "change", channel: "public:posts", event: "UPDATE",
        payload: { new: { id: 1 }, old: { id: 1 } }, timestamp: "t2",
      })
      simulateServerMessage(ws, {
        type: "change", channel: "public:posts", event: "DELETE",
        payload: { new: null, old: { id: 1 } }, timestamp: "t3",
      })

      expect(allEvents).toHaveLength(3)
      expect(allEvents.map((e) => e.eventType)).toEqual(["INSERT", "UPDATE", "DELETE"])
    })
  })

  describe("Unsubscribe stops event delivery", () => {
    it("no events received after unsubscribe", async () => {
      const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: "key" })
      const events: RealtimePayload<Record<string, unknown>>[] = []

      const sub = client
        .channel<Record<string, unknown>>("public:posts")
        .on("postgres_changes", { event: "*" }, (p) => events.push(p))
        .subscribe()

      await new Promise((resolve) => setTimeout(resolve, 10))
      const ws = MockWS.instances[0]!
      simulateServerMessage(ws, { type: "system", status: "ok", message: "subscribed to public:posts" })

      // Receive one event
      simulateServerMessage(ws, {
        type: "change", channel: "public:posts", event: "INSERT",
        payload: { new: { id: 1 }, old: null }, timestamp: "t1",
      })
      expect(events).toHaveLength(1)

      // Unsubscribe
      sub.unsubscribe()

      // This event should NOT be delivered
      simulateServerMessage(ws, {
        type: "change", channel: "public:posts", event: "INSERT",
        payload: { new: { id: 2 }, old: null }, timestamp: "t2",
      })

      expect(events).toHaveLength(1)
    })
  })
})
