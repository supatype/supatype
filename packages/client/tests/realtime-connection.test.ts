/**
 * The connection-level signal: `isConnected` and `onConnectionChange`, and the reconnect backoff.
 *
 * A channel's status cannot tell a first connect from a reconnect after a drop (both read
 * SUBSCRIBING), so a page that wants to refetch what it missed needs the socket's own state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RealtimeClient, type RealtimeConnectionState } from "../src/realtime.js"
import { createMockWebSocketClass, type MockWebSocketInstance } from "./helpers/mock-websocket.js"

let instances: MockWebSocketInstance[]
let realtime: RealtimeClient

beforeEach(() => {
  const mock = createMockWebSocketClass()
  instances = mock.instances
  vi.stubGlobal("WebSocket", mock.MockWebSocket)
  realtime = new RealtimeClient("ws://localhost:4000/realtime", async () => ({ Authorization: "Bearer t" }))
})

afterEach(() => {
  realtime.disconnect()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Node has no CloseEvent; the client never reads the event. */
const dropEvent = (): CloseEvent => new Event("close") as CloseEvent
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
const newest = (): MockWebSocketInstance => instances[instances.length - 1] as MockWebSocketInstance

function record(): RealtimeConnectionState[] {
  const seen: RealtimeConnectionState[] = []
  realtime.onConnectionChange((state) => seen.push(state))
  return seen
}

describe("isConnected and onConnectionChange", () => {
  it("is disconnected before anything subscribes", () => {
    expect(realtime.isConnected).toBe(false)
    expect(realtime.connectionState).toBe("disconnected")
  })

  it("reports connecting, then connected, when the first channel subscribes", async () => {
    const seen = record()
    realtime.channel("public:task").subscribe(() => {})
    await settle()

    expect(seen).toEqual(["connecting", "connected"])
    expect(realtime.isConnected).toBe(true)
  })

  it("reports a drop as connecting, and connected again once the socket is back", async () => {
    realtime.channel("public:task").subscribe(() => {})
    await settle()
    const seen = record()

    newest().onclose?.(dropEvent())
    expect(seen).toEqual(["connecting"])
    expect(realtime.isConnected).toBe(false)

    await vi.waitFor(() => expect(seen).toEqual(["connecting", "connected"]), { timeout: 3000 })
    expect(realtime.isConnected).toBe(true)
  })

  it("reports disconnected on an explicit disconnect", async () => {
    realtime.channel("public:task").subscribe(() => {})
    await settle()
    const seen = record()

    realtime.disconnect()
    expect(seen).toEqual(["disconnected"])
    expect(realtime.isConnected).toBe(false)
  })

  it("reports connecting, not disconnected, across the re-authentication swap", async () => {
    let token = "anon"
    realtime = new RealtimeClient("ws://localhost:4000/realtime", async () => ({ Authorization: `Bearer ${token}` }))
    realtime.channel("public:task").subscribe(() => {})
    await settle()
    const seen = record()

    token = "user"
    await realtime.reauthenticate()
    await settle()

    expect(seen).toEqual(["connecting", "connected"])
  })

  it("stops calling a listener once it unsubscribes, and ignores a second unsubscribe", async () => {
    const seen: RealtimeConnectionState[] = []
    const off = realtime.onConnectionChange((state) => seen.push(state))
    off()
    off()
    realtime.channel("public:task").subscribe(() => {})
    await settle()

    expect(seen).toEqual([])
  })

  it("keeps notifying the others when one listener throws", async () => {
    const seen: RealtimeConnectionState[] = []
    realtime.onConnectionChange(() => {
      throw new Error("listener bug")
    })
    realtime.onConnectionChange((state) => seen.push(state))
    realtime.channel("public:task").subscribe(() => {})
    await settle()

    expect(seen).toEqual(["connecting", "connected"])
  })

  it("does not change what a channel reports", async () => {
    const statuses: string[] = []
    realtime.channel("public:task").subscribe((status) => statuses.push(status))
    await settle()
    newest().onclose?.(dropEvent())

    expect(statuses).toEqual(["SUBSCRIBING"])
  })
})

describe("reconnect backoff", () => {
  it("doubles from one second and holds at 30 seconds", async () => {
    vi.useFakeTimers()
    // A socket that never opens, so the attempt counter is never reset.
    const dead: MockWebSocketInstance[] = []
    class DeadSocket {
      static OPEN = 1
      static CONNECTING = 0
      static CLOSED = 3
      readyState = 0
      onopen = null
      onclose: ((event: CloseEvent) => void) | null = null
      onmessage = null
      onerror = null
      send = vi.fn<(data: string) => void>()
      close = vi.fn<() => void>()
      constructor(readonly url: string) {
        dead.push(this)
      }
    }
    vi.stubGlobal("WebSocket", DeadSocket)
    realtime = new RealtimeClient("ws://localhost:4000/realtime", async () => ({ Authorization: "Bearer t" }))
    const spy = vi.spyOn(globalThis, "setTimeout")

    realtime.channel("public:task").subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const delays: number[] = []
    for (let i = 0; i < 10; i++) {
      const before = spy.mock.calls.length
      dead[dead.length - 1]?.onclose?.(dropEvent())
      const delay = spy.mock.calls.slice(before).map((c) => Number(c[1])).find((d) => d >= 1000)
      delays.push(delay ?? -1)
      await vi.advanceTimersByTimeAsync(delay ?? 0)
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
  })
})

describe("a socket that fails before it opens and never closes", () => {
  // Node's built-in WebSocket, against a gateway answering 502 while realtime restarts, fires
  // error and then nothing: readyState stays CONNECTING. Waiting for a close that never comes
  // left the client counting that socket as live, so it never tried again (seen on 0.9.3).
  it("drops the socket on the error and reconnects", async () => {
    realtime.channel("public:task").subscribe(() => {})
    await settle()
    const seen = record()
    const first = newest()
    first.readyState = 0
    first.onerror?.(new Event("error"))

    expect(seen).toEqual(["connecting"])
    await vi.waitFor(() => expect(instances.length).toBe(2), { timeout: 3000 })
    await vi.waitFor(() => expect(seen).toEqual(["connecting", "connected"]), { timeout: 3000 })
  })

  it("leaves an open socket's error to its close", async () => {
    realtime.channel("public:task").subscribe(() => {})
    await settle()
    const seen = record()
    newest().onerror?.(new Event("error"))
    await settle()

    expect(seen).toEqual([])
    expect(instances.length).toBe(1)
  })
})

describe("a socket that never finishes its handshake", () => {
  // Seen on 0.9.3 self-host: realtime restarted under a held socket, the new one stayed
  // CONNECTING with no error and no close, and the client waited on it for good.
  it("is given up after the connect timeout and replaced", async () => {
    vi.useFakeTimers()
    const made: Array<{ readyState: number; close: () => void }> = []
    class SilentSocket {
      static OPEN = 1
      static CONNECTING = 0
      static CLOSED = 3
      readyState = 0
      onopen = null
      onclose = null
      onmessage = null
      onerror = null
      send = vi.fn<(data: string) => void>()
      close = vi.fn<() => void>()
      constructor(readonly url: string) {
        made.push(this)
      }
    }
    vi.stubGlobal("WebSocket", SilentSocket)
    realtime = new RealtimeClient("ws://localhost:4000/realtime", async () => ({ Authorization: "Bearer t" }))
    realtime.channel("public:task").subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(made.length).toBe(1)

    await vi.advanceTimersByTimeAsync(11_000)
    expect(made[0]?.close).toHaveBeenCalled()
    expect(made.length).toBe(2)
  })
})
