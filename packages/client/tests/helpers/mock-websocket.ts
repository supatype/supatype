import { vi } from "vitest"

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
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

export function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket
  instances: MockWebSocketInstance[]
} {
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

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances }
}

/** Simulate a server message arriving on a WebSocket instance. */
export function simulateServerMessage(
  ws: MockWebSocketInstance,
  msg: Record<string, unknown>,
): void {
  ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
}

/** The token a socket was opened with, read back out of its URL. */
export function tokenOf(ws: MockWebSocketInstance): string | null {
  return new URL(ws.url.replace(/^ws/, "http")).searchParams.get("token")
}
