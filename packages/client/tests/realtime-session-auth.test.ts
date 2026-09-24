/**
 * The realtime socket authenticates as the signed-in user, not as anon.
 *
 * This is the defect these cover: `createClient` handed `RealtimeClient` the header bag built at
 * construction, whose Authorization is the anon key and is never rewritten, and the socket then
 * preferred `apikey` over Authorization anyway. Realtime enforces RLS, so on any table that is not
 * anon-readable the socket reported SUBSCRIBED and delivered nothing at all. Proven against a live
 * stack before it was fixed: two sockets, one insert, the anon socket saw 0 payloads and the
 * signed-in socket saw 1.
 *
 * Every binding subscribes on mount, which is before sign-in, so the reconnect case below is the
 * one that actually matters in an app.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RealtimeClient } from "../src/realtime.js"
import {
  createMockWebSocketClass,
  tokenOf,
  type MockWebSocketInstance,
} from "./helpers/mock-websocket.js"
import { createClient } from "../src/index.js"
import type { Session } from "../src/types.js"

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** What a signed-in caller's headers look like: the bearer is the session, the apikey never is. */
function bearerHeaders(token: string): Record<string, string> {
  return { apikey: "anon-key", Authorization: `Bearer ${token}` }
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${btoa(JSON.stringify(payload))}.sig`
}

const ANON_KEY = fakeJwt({ role: "anon" })
const USER_TOKEN = fakeJwt({
  role: "authenticated",
  sub: "user-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
})

function session(accessToken: string): Session {
  return {
    accessToken,
    tokenType: "bearer",
    expiresIn: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "refresh-1",
    user: {
      id: "user-1",
      email: "a@b.com",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
  } as Session
}

describe("realtime authenticates as the session, not as anon", () => {
  let MockWS: ReturnType<typeof createMockWebSocketClass>

  beforeEach(() => {
    vi.restoreAllMocks()
    MockWS = createMockWebSocketClass()
    vi.stubGlobal("WebSocket", MockWS.MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("prefers the Authorization bearer over apikey when given headers", async () => {
    const client = new RealtimeClient("ws://localhost:4000/realtime", {
      apikey: ANON_KEY,
      Authorization: `Bearer ${USER_TOKEN}`,
    })
    client.channel("public:task").subscribe()
    await settle()

    expect(tokenOf(MockWS.instances[0]!)).toBe(USER_TOKEN)
  })

  it("falls back to apikey when there is no Authorization header", async () => {
    const client = new RealtimeClient("ws://localhost:4000/realtime", { apikey: ANON_KEY })
    client.channel("public:task").subscribe()
    await settle()

    expect(tokenOf(MockWS.instances[0]!)).toBe(ANON_KEY)
  })

  it("opens the socket with the token the provider returns at connect time", async () => {
    let token = "first"
    const client = new RealtimeClient("ws://localhost:4000/realtime", () => bearerHeaders(token))
    client.channel("public:task").subscribe()
    await settle()
    expect(tokenOf(MockWS.instances[0]!)).toBe("first")

    token = "second"
    await client.reauthenticate()
    await settle()

    expect(MockWS.instances).toHaveLength(2)
    expect(tokenOf(MockWS.instances[1]!)).toBe("second")
  })

  it("does not reconnect when the token has not changed", async () => {
    const client = new RealtimeClient("ws://localhost:4000/realtime", () => bearerHeaders("same"))
    client.channel("public:task").subscribe()
    await settle()

    await client.reauthenticate()
    await settle()

    expect(MockWS.instances).toHaveLength(1)
  })

  it("re-subscribes every channel on the replacement socket", async () => {
    let token = "before"
    const client = new RealtimeClient("ws://localhost:4000/realtime", () => bearerHeaders(token))
    client.channel("public:task").subscribe()
    await settle()

    token = "after"
    await client.reauthenticate()
    await settle()

    const replacement = MockWS.instances[1]!
    const subscribes = replacement.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; channel: string })
      .filter((m) => m.type === "subscribe")
    expect(subscribes.map((m) => m.channel)).toContain("public:task")
  })

  it("reconnects when the identity changes while the first connect is still resolving its token", async () => {
    // Not a hypothetical window. The provider `createClient` passes awaits `getAuthHeaders()`, which
    // can make a session-refresh round trip, so any sign-in landing during one lands here. Every
    // other test in this file uses a synchronous provider and never enters it.
    let releaseFirst: (headers: Record<string, string>) => void = () => {}
    const firstHeaders = new Promise<Record<string, string>>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const client = new RealtimeClient("ws://localhost:4000/realtime", () => {
      calls += 1
      return calls === 1 ? firstHeaders : Promise.resolve(bearerHeaders("after-sign-in"))
    })

    client.channel("public:task").subscribe()
    await Promise.resolve()

    const reauthenticated = client.reauthenticate()
    releaseFirst(bearerHeaders("before-sign-in"))
    await reauthenticated
    await settle()

    // The socket must exist and must carry the new token. Abandoning the in-flight attempt without
    // starting a replacement leaves the page connected to nothing, with no retry scheduled.
    expect(MockWS.instances.length).toBeGreaterThan(0)
    expect(tokenOf(MockWS.instances[MockWS.instances.length - 1]!)).toBe("after-sign-in")
  })

  it("createClient gives realtime the session token rather than the anon key", async () => {
    const client = createClient({
      url: "http://localhost:18473",
      anonKey: ANON_KEY,
      initialSession: session(USER_TOKEN),
    })
    client.realtime.channel("public:task").subscribe()
    await settle()

    // The whole bug in one assertion: this was ANON_KEY, and the socket then saw no rows.
    expect(tokenOf(MockWS.instances[0]!)).toBe(USER_TOKEN)
  })
})
