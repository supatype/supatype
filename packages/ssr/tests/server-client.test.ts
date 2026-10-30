/**
 * A session refreshed on the server goes back to the browser through the adapter's `setAll`, in the
 * cookie the browser client writes and `parseSessionFromCookies` reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServerClient } from "../src/index.js"
import { parseSessionFromCookies } from "../src/cookie-parser.js"
import type { CookieAdapter, CookieToSet } from "../src/index.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** An unsigned JWT whose `exp` is `offsetSeconds` from now. */
function jwt(offsetSeconds: number, sub = "user-1"): string {
  const payload = { sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + offsetSeconds }
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`
}

/** The cookie the browser client writes for a session. */
function sessionCookie(accessToken: string, refreshToken: string): { name: string; value: string } {
  const value = JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, user: { id: "user-1" } })
  return { name: "st-auth-token", value: encodeURIComponent(value) }
}

/** An adapter over `cookies` that records every `setAll` call. */
function adapter(cookies: Array<{ name: string; value: string }>): { cookies: CookieAdapter; written: CookieToSet[][] } {
  const written: CookieToSet[][] = []
  return { cookies: { getAll: () => cookies, setAll: (c) => written.push(c) }, written }
}

/** A fetch the auth server answers: a refresh grant with `refresh`, anything else with `[]`. */
function stubFetch(refresh: { status: number; body: Record<string, unknown> }): void {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const answer = url.includes("grant_type=refresh_token") ? refresh : { status: 200, body: {} }
    return Promise.resolve(new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    }))
  }))
}

describe("createServerClient", () => {
  it("writes nothing for a session that needs no refresh", async () => {
    stubFetch({ status: 500, body: {} })
    const { cookies, written } = adapter([sessionCookie(jwt(3600), "r1")])
    const client = createServerClient("http://api.test", "anon", { cookies })
    await client.auth.ensureValidSession()
    expect(written).toEqual([])
  })

  it("writes the refreshed session back in the cookie the parser reads", async () => {
    const fresh = jwt(3600)
    stubFetch({ status: 200, body: { access_token: fresh, refresh_token: "r2", expires_in: 3600, user: { id: "user-1" } } })
    const { cookies, written } = adapter([sessionCookie(jwt(-60), "r1")])
    const client = createServerClient("http://api.test", "anon", { cookies })
    await client.auth.ensureValidSession()

    const set = written.flat()
    expect(set.map((c) => c.name)).toEqual(["st-auth-token"])
    const session = parseSessionFromCookies(set)
    expect(session).toMatchObject({ accessToken: fresh, refreshToken: "r2", user: { id: "user-1" } })
    expect(set[0]?.options).toMatchObject({ path: "/", sameSite: "lax" })
  })

  it("clears the cookie when the refresh is refused", async () => {
    stubFetch({ status: 400, body: { error: "invalid_grant" } })
    const { cookies, written } = adapter([sessionCookie(jwt(-60), "r1")])
    const client = createServerClient("http://api.test", "anon", { cookies })
    await client.auth.ensureValidSession()

    expect(written.flat()).toEqual([{ name: "st-auth-token", value: "", options: { path: "/", maxAge: 0 } }])
  })

  it("uses the configured prefix for the written cookie", async () => {
    stubFetch({ status: 200, body: { access_token: jwt(3600), refresh_token: "r2", user: { id: "user-1" } } })
    const old = { ...sessionCookie(jwt(-60), "r1"), name: "myapp-auth-token" }
    const { cookies, written } = adapter([old])
    await createServerClient("http://api.test", "anon", { cookies, cookiePrefix: "myapp" }).auth.ensureValidSession()
    expect(written.flat().map((c) => c.name)).toEqual(["myapp-auth-token"])
  })

})

/**
 * A server client lives for one request. A refresh it starts on its own rotates the browser's refresh
 * token, and a timer it leaves behind outlives the request it was made for.
 */
describe("createServerClient lifetime", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** The Authorization header of the last request the stubbed fetch answered. */
  function lastAuthorization(): string | null {
    const last = vi.mocked(fetch).mock.calls.at(-1)
    if (last === undefined) return null
    const [input, init] = last
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    return headers.get("Authorization")
  }

  /** The refresh grants the stubbed fetch has answered. */
  function refreshCalls(): number {
    const calls = vi.mocked(fetch).mock.calls
    return calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes("grant_type=refresh_token")).length
  }

  it("schedules no refresh timer", () => {
    vi.useFakeTimers()
    stubFetch({ status: 500, body: {} })
    const { cookies } = adapter([sessionCookie(jwt(3600), "r1")])
    createServerClient("http://api.test", "anon", { cookies })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not refresh an expired session until a request needs it", async () => {
    const fresh = jwt(3600)
    stubFetch({ status: 200, body: { access_token: fresh, refresh_token: "r2", user: { id: "user-1" } } })
    const { cookies, written } = adapter([sessionCookie(jwt(-60), "r1")])
    const client = createServerClient("http://api.test", "anon", { cookies })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refreshCalls()).toBe(0)
    expect(written).toEqual([])

    await client.from("posts").select("*")
    expect(refreshCalls()).toBe(1)
    expect(parseSessionFromCookies(written.flat())).toMatchObject({ accessToken: fresh, refreshToken: "r2" })
  })

  it("refreshes and writes the cookies back with an adapter `setAll`", async () => {
    const fresh = jwt(3600)
    stubFetch({ status: 200, body: { access_token: fresh, refresh_token: "r2", user: { id: "user-1" } } })
    const { cookies, written } = adapter([sessionCookie(jwt(-60), "r1")])
    const client = createServerClient("http://api.test", "anon", { cookies })
    await client.from("posts").select("*")
    expect(refreshCalls()).toBe(1)
    expect(lastAuthorization()).toBe(`Bearer ${fresh}`)
    expect(parseSessionFromCookies(written.flat())).toMatchObject({ accessToken: fresh, refreshToken: "r2" })
  })

  // Without `setAll` (a Server Component) the browser never receives what a refresh returns, and the
  // refresh has already spent the refresh token the browser holds, so its next refresh is refused.
  it("never refreshes without an adapter `setAll`: the expired token goes out as it is", async () => {
    stubFetch({ status: 200, body: { access_token: jwt(3600), refresh_token: "r2", user: { id: "user-1" } } })
    const expired = jwt(-60)
    const client = createServerClient("http://api.test", "anon", {
      cookies: { getAll: () => [sessionCookie(expired, "r1")] },
    })
    await client.from("posts").select("*")
    const { data } = await client.auth.getSession()
    expect(refreshCalls()).toBe(0)
    expect(lastAuthorization()).toBe(`Bearer ${expired}`)
    expect(data.session?.accessToken).toBe(expired)
  })

  it("keeps the session out of any storage the runtime provides", async () => {
    const setItem = vi.fn<(key: string, value: string) => void>()
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem, removeItem: () => undefined } })
    stubFetch({ status: 200, body: { access_token: jwt(3600), refresh_token: "r2", user: { id: "user-1" } } })
    const { cookies } = adapter([sessionCookie(jwt(-60), "r1")])
    await createServerClient("http://api.test", "anon", { cookies }).auth.ensureValidSession()
    expect(setItem).not.toHaveBeenCalled()
  })
})
