import { describe, it, expect, vi, beforeEach } from "vitest"
import { createClient, type Session } from "../src/index.js"
import { fetchCalls, header, jsonResponse, mockFetch, requestUrl } from "./support/fetch-mock.js"
import { fakeJwt } from "./support/jwt.js"

// A resend follows only a refresh that replaced a refused session token, so the caller is signed in.
const NOW = Math.floor(Date.now() / 1000)
const userJwt = (n: number): string => fakeJwt({ role: "authenticated", sub: "u1", exp: NOW + 3600, n })

const USER = { id: "u1", appMetadata: {}, userMetadata: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
const SESSION: Session = { accessToken: userJwt(1), tokenType: "bearer", expiresIn: 3600, refreshToken: "rt-1", user: USER }
const REFRESHED = {
  access_token: userJwt(2),
  refresh_token: "rt-2",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "u1", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
}

describe("rpc: the resend after a 401 is the same request", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("keeps Content-Profile and Prefer on the second send", async () => {
    let refused = false
    const fetch = mockFetch((input) => {
      if (requestUrl(input).includes("/auth/v1/token")) return Promise.resolve(jsonResponse(REFRESHED))
      if (refused) return Promise.resolve(jsonResponse(1, 200))
      refused = true
      return Promise.resolve(jsonResponse({ code: "PGRST303", message: "JWT expired" }, 401))
    })
    vi.stubGlobal("fetch", fetch)
    const client = createClient({
      url: "http://localhost:18473",
      anonKey: "anon",
      auth: { persistSession: false, autoRefreshToken: false },
      initialSession: SESSION,
    })

    const { error } = await client.rpc("publish", undefined, { schema: "supatype", count: "exact" })

    expect(error).toBeNull()
    const sends = fetchCalls(fetch).filter(({ url }) => url.includes("/rpc/publish"))
    expect(sends).toHaveLength(2)
    for (const { init } of sends) {
      expect(header(init, "Content-Profile")).toBe("supatype")
      expect(header(init, "Prefer")).toBe("count=exact")
    }
  })
})
