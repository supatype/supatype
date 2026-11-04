import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type AnyDatabase, type Session } from "../src/index.js"
import { fetchCalls, header, jsonResponse, mockFetch, requestUrl, type FetchMock } from "./support/fetch-mock.js"
import { fakeJwt } from "./support/jwt.js"

// A 401 is resent only when the server said the token was expired or invalid, a session was there to
// refresh, and the refresh produced a different token. Anything else (a row rule refusing an anon
// write, above all) goes out once: sending it again only repeats the refusal, and a write twice.

const BASE = "http://localhost:18473"
const ANON_KEY = "anon-key"
const NOW = Math.floor(Date.now() / 1000)

const STALE = fakeJwt({ role: "authenticated", sub: "user-1", exp: NOW + 3600, n: 1 })
const FRESH = fakeJwt({ role: "authenticated", sub: "user-1", exp: NOW + 7200, n: 2 })

/** A session the local clock still calls valid, which the server has nonetheless refused. */
const SESSION: Session = {
  accessToken: STALE,
  tokenType: "bearer",
  expiresIn: 3600,
  expiresAt: NOW + 3600,
  refreshToken: "rt-1",
  user: { id: "user-1", appMetadata: {}, userMetadata: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
}

const RAW_USER = { id: "user-1", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }

/** PostgREST refusing an anon write a row rule does not allow. */
const RLS_REFUSAL = { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "orders"' }
/** PostgREST 14 refusing an expired token. */
const EXPIRED = { code: "PGRST303", details: null, hint: null, message: "JWT expired" }

/** Answers the table with `refusal` until a request carries FRESH, and the refresh with `refreshed`. */
function server(refusal: Record<string, unknown>, refreshed: string): FetchMock {
  return mockFetch((input, init) => {
    if (requestUrl(input).includes("/auth/v1/token")) {
      return Promise.resolve(
        jsonResponse({ access_token: refreshed, refresh_token: "rt-2", token_type: "bearer", expires_in: 3600, user: RAW_USER }),
      )
    }
    const fresh = header(init ?? {}, "Authorization") === `Bearer ${FRESH}`
    return Promise.resolve(fresh ? jsonResponse(null, 201) : jsonResponse(refusal, 401))
  })
}

function serve(fetch: FetchMock): FetchMock {
  vi.stubGlobal("fetch", fetch)
  return fetch
}

const tableCalls = (fetch: FetchMock) => fetchCalls(fetch).filter(({ url }) => url.includes("/rest/v1/orders"))
const refreshCalls = (fetch: FetchMock) => fetchCalls(fetch).filter(({ url }) => url.includes("/auth/v1/token"))

function signedIn() {
  return createClient<AnyDatabase>({
    url: BASE,
    anonKey: ANON_KEY,
    auth: { persistSession: false, autoRefreshToken: false },
    initialSession: SESSION,
  })
}

describe("the resend after a 401", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is not made for an anon write a row rule refused", async () => {
    const fetch = serve(server(RLS_REFUSAL, FRESH))
    const client = createClient<AnyDatabase>({ url: BASE, anonKey: ANON_KEY, auth: { persistSession: false } })
    const { error } = await client.from("orders").insert({ item: "latte" })
    expect(error).toMatchObject({ code: "42501", status: 401 })
    expect(tableCalls(fetch)).toHaveLength(1)
    expect(refreshCalls(fetch)).toHaveLength(0)
  })

  it("is not made for a signed-in write a row rule refused, and nothing is refreshed", async () => {
    const fetch = serve(server(RLS_REFUSAL, FRESH))
    const { error } = await signedIn().from("orders").insert({ item: "latte" })
    expect(error).toMatchObject({ code: "42501" })
    expect(tableCalls(fetch)).toHaveLength(1)
    expect(refreshCalls(fetch)).toHaveLength(0)
  })

  it("refreshes an expired token the local clock calls valid, and sends again with the new one", async () => {
    const fetch = serve(server(EXPIRED, FRESH))
    const { error } = await signedIn().from("orders").insert({ item: "latte" })
    expect(error).toBeNull()
    expect(refreshCalls(fetch)).toHaveLength(1)
    expect(tableCalls(fetch).map(({ init }) => header(init, "Authorization"))).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`])
  })

  it("is not made when the refresh hands back the token the server refused", async () => {
    const fetch = serve(server(EXPIRED, STALE))
    const { error } = await signedIn().from("orders").insert({ item: "latte" })
    expect(error).toMatchObject({ code: "PGRST303" })
    expect(refreshCalls(fetch)).toHaveLength(1)
    expect(tableCalls(fetch)).toHaveLength(1)
  })

  it("is not made for an anon caller whose token the server called expired, there being no session", async () => {
    const fetch = serve(server(EXPIRED, FRESH))
    const client = createClient<AnyDatabase>({ url: BASE, anonKey: ANON_KEY, auth: { persistSession: false } })
    await client.from("orders").select("id")
    expect(tableCalls(fetch)).toHaveLength(1)
    expect(refreshCalls(fetch)).toHaveLength(0)
  })
})
