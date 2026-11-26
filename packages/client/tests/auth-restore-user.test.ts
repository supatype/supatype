import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "../src/auth.js"
import type { AuthStorage } from "../src/types.js"
import { fetchReturning } from "./support/fetch-mock.js"

const URL_ = "http://localhost:9999"
const HEADERS = { apikey: "k", "Content-Type": "application/json" }

function memoryStorage(): AuthStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: async (k: string) => data.get(k) ?? null,
    setItem: async (k: string, v: string) => void data.set(k, v),
    removeItem: async (k: string) => void data.delete(k),
  }
}

function tokenWith(claims: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "HS256" })}.${enc({ exp: 4102444800, ...claims })}.sig`
}

const ANON_RESPONSE = {
  access_token: tokenWith({ is_anonymous: true }),
  refresh_token: "r",
  token_type: "bearer",
  expires_in: 3600,
  user: {
    id: "u1",
    is_anonymous: true,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    identities: [
      { id: "i1", user_id: "u1", identity_id: "x", provider: "anonymous", identity_data: { a: 1 }, created_at: "c", updated_at: "u", last_sign_in_at: "l" },
    ],
    factors: [{ id: "f1", factor_type: "totp", status: "verified", friendly_name: "phone", created_at: "c", updated_at: "u" }],
  },
}

describe("restored session keeps the user's camelCase fields", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("isAnonymous survives anonymous sign-in, persist and restore", async () => {
    const storage = memoryStorage()
    const first = new AuthClient(URL_, HEADERS, { storage })
    await first.whenReady()
    vi.stubGlobal("fetch", fetchReturning(ANON_RESPONSE, 200))
    const signedIn = await first.signInAnonymously()
    expect(signedIn.data.user?.isAnonymous).toBe(true)
    await vi.waitFor(() => expect(storage.data.size).toBe(1))

    const second = new AuthClient(URL_, HEADERS, { storage })
    await second.whenReady()
    const { data } = await second.getSession()
    expect(data.session?.user.isAnonymous).toBe(true)
  })

  it("identities and factors survive a restore", async () => {
    const storage = memoryStorage()
    const first = new AuthClient(URL_, HEADERS, { storage })
    await first.whenReady()
    vi.stubGlobal("fetch", fetchReturning(ANON_RESPONSE, 200))
    const signedIn = await first.signInAnonymously()
    await vi.waitFor(() => expect(storage.data.size).toBe(1))

    const second = new AuthClient(URL_, HEADERS, { storage })
    await second.whenReady()
    const restored = (await second.getSession()).data.session?.user
    expect(restored?.identities).toEqual(signedIn.data.user?.identities)
    expect(restored?.factors).toEqual(signedIn.data.user?.factors)
  })

  it("takes isAnonymous from the token claim when the stored user lacks it", async () => {
    const storage = memoryStorage()
    storage.data.set(
      "supatype.auth.session",
      JSON.stringify({ accessToken: tokenWith({ is_anonymous: true }), refreshToken: "r", tokenType: "bearer", expiresIn: 3600, user: { id: "u1" } }),
    )
    const client = new AuthClient(URL_, HEADERS, { storage })
    await client.whenReady()
    expect((await client.getSession()).data.session?.user.isAnonymous).toBe(true)
  })
})
