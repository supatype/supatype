/**
 * Data plane waits for session refresh before attaching JWTs to REST requests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createClient } from "../src/index.js"

const BASE = "http://localhost:18473"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test"
const GOTRUE = `${BASE}/auth/v1`

function fakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

const RAW_USER = {
  id: "user-1",
  email: "a@b.com",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
}


describe("createClient data plane auth", () => {
  let store: Map<string, string>

  beforeEach(() => {
    vi.restoreAllMocks()
    store = new Map<string, string>()
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    }
    vi.stubGlobal("localStorage", localStorage)
    vi.stubGlobal("window", { localStorage, location: { protocol: "http:" } })
    vi.stubGlobal("document", { cookie: "" })
  })

  it("refreshes expired session before REST request and uses new access token", async () => {
    const expiredAccess = fakeJwt({
      role: "authenticated",
      sub: "user-1",
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const freshAccess = fakeJwt({
      role: "authenticated",
      sub: "user-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const expiredSession = {
      access_token: expiredAccess,
      refresh_token: "valid-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: RAW_USER,
    }
    store.set("supatype.auth.session", JSON.stringify(expiredSession))

    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/v1/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: freshAccess,
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: RAW_USER,
          }),
          headers: { get: () => null },
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "1", title: "Hello" }],
        headers: { get: () => null },
      }
    })
    vi.stubGlobal("fetch", fetchSpy)

    const client = createClient({ url: BASE, anonKey: ANON_KEY })
    const { data, error } = await client.from("post").select("id,title")

    expect(error).toBeNull()
    expect(data).toEqual([{ id: "1", title: "Hello" }])

    const restCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/rest/v1/post"),
    ) as [string, RequestInit] | undefined
    expect(restCall).toBeDefined()
    expect((restCall![1].headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${freshAccess}`,
    )
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes(`${GOTRUE}/token`))).toBe(true)
  })

  it("falls back to anon headers after refresh fails", async () => {
    const expiredAccess = fakeJwt({
      role: "authenticated",
      sub: "user-1",
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const expiredSession = {
      access_token: expiredAccess,
      refresh_token: "dead-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: RAW_USER,
    }
    store.set("supatype.auth.session", JSON.stringify(expiredSession))

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/auth/v1/token")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error_description: "Invalid Refresh Token" }),
          headers: { get: () => null },
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "1", title: "Anon ok" }],
        headers: { get: () => null },
      }
    })
    vi.stubGlobal("fetch", fetchSpy)

    const client = createClient({ url: BASE, anonKey: ANON_KEY })
    const { data, error } = await client.from("post").select("id,title")

    expect(error).toBeNull()
    expect(data).toEqual([{ id: "1", title: "Anon ok" }])

    const restCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/rest/v1/post"),
    ) as [string, RequestInit] | undefined
    expect((restCall![1].headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${ANON_KEY}`,
    )
    expect(store.get("supatype.auth.session")).toBeUndefined()
  })
})
