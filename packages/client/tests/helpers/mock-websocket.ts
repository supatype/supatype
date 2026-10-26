import { vi, type Mock } from "vitest"
import { isJsonObject } from "../../src/json.js"

/**
 * A stand-in WebSocket for the realtime suites.
 *
 * Shared because two suites drive the same socket lifecycle, and that lifecycle has just grown a
 * one-at-a-time connect guard and a detach-before-close path. Two copies of the fake would have to
 * learn each of those separately, and the first one to forget would pass while describing a client
 * that no longer exists.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export interface MockWebSocketInstance {
  url: string
  readyState: number
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  /** The client only ever sends JSON text. */
  send: Mock<(data: string) => void>
  close: Mock<() => void>
}

/** What the realtime client uses of the WebSocket constructor: `new` and the ready states. */
export interface MockWebSocketClass {
  new (url: string): MockWebSocketInstance
  readonly OPEN: number
  readonly CONNECTING: number
  readonly CLOSED: number
}

export function createMockWebSocketClass(): {
  MockWebSocket: MockWebSocketClass
  instances: MockWebSocketInstance[]
} {
  const instances: MockWebSocketInstance[] = []

  class MockWebSocket implements MockWebSocketInstance {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3

    url: string
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    send = vi.fn<(data: string) => void>()
    close = vi.fn<() => void>()

    constructor(url: string) {
      this.url = url
      instances.push(this)

      // Auto-open after a microtask
      queueMicrotask(() => {
        this.readyState = 1 // OPEN
        this.onopen?.(new Event("open"))
      })
    }
  }

  return { MockWebSocket, instances }
}

/** Simulate a server message arriving on a WebSocket instance. */
export function simulateServerMessage(
  ws: MockWebSocketInstance,
  msg: Record<string, unknown>,
): void {
  ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }))
}

/** The token a socket was opened with, read back out of its URL. */
export function tokenOf(ws: MockWebSocketInstance): string | null {
  return new URL(ws.url.replace(/^ws/, "http")).searchParams.get("token")
}

/** Every frame the client sent on a socket, parsed. A frame that is not a JSON object fails the test. */
export function sentFrames(ws: MockWebSocketInstance): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([raw]) => {
    const frame = JSON.parse(raw)
    if (!isJsonObject(frame)) throw new Error(`the client sent a frame that is not a JSON object: ${raw}`)
    return frame
  })
}

/** The channels a socket was asked to join, in the order the subscribe frames went out. */
export function subscribedChannels(ws: MockWebSocketInstance): string[] {
  return sentFrames(ws)
    .filter((frame) => frame["type"] === "subscribe")
    .map(channelOf)
}

/** The channel a frame names. Fails the test when it names none. */
export function channelOf(frame: Record<string, unknown> | undefined): string {
  const channel = frame?.["channel"]
  if (typeof channel !== "string") throw new Error(`the frame names no channel: ${JSON.stringify(frame)}`)
  return channel
}
