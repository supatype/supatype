import { describe, it, expect, vi, afterEach } from "vitest"
import { AuthClient } from "../src/auth.js"
import { createClient } from "../src/index.js"
import type { AuthChangeEvent } from "../src/types.js"

/**
 * The OAuth return: the auth server sends the browser back with the session in the URL, as tokens in
 * the fragment (implicit) or a `code` in the query (PKCE). The client finishes the sign-in itself on
 * start, as supabase-js does with `detectSessionInUrl`, so no app has to read the URL.
 */

const AUTH_URL = "http://localhost:9999/auth/v1"
const HEADERS = { apikey: "anon", "Content-Type": "application/json" }
const VERIFIER_KEY = "supatype.auth.session-code-verifier"
const PROVIDER_KEY = "supatype.auth.session-oauth-provider"

const RAW_USER = {
  id: "user-1",
  email: "ada@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "github" },
  user_metadata: { full_name: "Ada Lovelace" },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function accessToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

/** A browser at `href`, with a localStorage holding `stored`. */
function stubBrowser(href: string, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored))
  const replaceState = vi.fn<(state: unknown, unused: string, url: string) => void>()
  vi.stubGlobal("window", {
    location: { href, protocol: "https:" },
    history: { state: null, replaceState },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
  return { replaceState, store }
}

function recordEvents(client: AuthClient): AuthChangeEvent[] {
  const events: AuthChangeEvent[] = []
  client.onAuthStateChange((event) => { events.push(event) })
  return events
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("detectSessionInUrl", () => {
  it("signs in from implicit-grant tokens in the fragment and cleans the URL", async () => {
    const token = accessToken()
    const { replaceState } = stubBrowser(
      `https://app.example/welcome?tab=1#access_token=${token}&refresh_token=rt-1&expires_in=3600&token_type=bearer&provider_token=gh&sb=`,
    )
    const fetch = vi.fn().mockResolvedValue(jsonResponse(RAW_USER))
    vi.stubGlobal("fetch", fetch)

    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    const { error } = await client.initialize()

    expect(error).toBeNull()
    expect(fetch.mock.calls[0]?.[0]).toBe(`${AUTH_URL}/user`)
    const { data } = await client.getSession()
    expect(data.session?.accessToken).toBe(token)
    expect(data.session?.user.userMetadata["full_name"]).toBe("Ada Lovelace")
    expect(events).toEqual(["SIGNED_OUT", "SIGNED_IN"])
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/welcome?tab=1")
  })

  it("exchanges a PKCE code from the query and keeps the app's own parameters", async () => {
    const { replaceState, store } = stubBrowser("https://app.example/cb?next=%2Fhome&code=auth-code-1", {
      [VERIFIER_KEY]: "verifier-1",
    })
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: accessToken(), refresh_token: "rt-2", expires_in: 3600, token_type: "bearer", user: RAW_USER }),
    )
    vi.stubGlobal("fetch", fetch)

    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    const { error } = await client.initialize()

    expect(error).toBeNull()
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTH_URL}/token?grant_type=pkce`)
    expect(JSON.parse(init.body as string)).toEqual({ auth_code: "auth-code-1", code_verifier: "verifier-1" })
    expect(events).toEqual(["SIGNED_OUT", "SIGNED_IN"])
    expect(store.has(VERIFIER_KEY)).toBe(false)
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/cb?next=%2Fhome")
  })

  it("leaves a `code` alone when this client started no PKCE flow", async () => {
    const { replaceState } = stubBrowser("https://app.example/invite?code=team-42")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    const { error } = await new AuthClient(AUTH_URL, HEADERS).initialize()

    expect(error).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it("reports a refused sign-in from the URL, naming the provider that was started, and cleans it", async () => {
    const { replaceState } = stubBrowser(
      "https://app.example/?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed&sb=",
      { [PROVIDER_KEY]: "github" },
    )
    vi.stubGlobal("fetch", vi.fn())

    const client = new AuthClient(AUTH_URL, HEADERS)
    const { error } = await client.initialize()

    expect(error?.message).toBe("Signups not allowed")
    expect(error?.code).toBe("signup_disabled")
    expect(error?.provider).toBe("github")
    expect((await client.getSession()).data.session).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/")
  })

  it("does nothing when the app opts out", async () => {
    const { replaceState } = stubBrowser(`https://app.example/#access_token=${accessToken()}&refresh_token=rt-1`)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    const client = createClient({ url: "http://localhost:9999", anonKey: "anon", auth: { detectSessionInUrl: false } })
    const { error } = await client.auth.initialize()

    expect(error).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
    expect((await client.auth.getSession()).data.session).toBeNull()
  })

  it("is on by default through createClient", async () => {
    stubBrowser(`https://app.example/#access_token=${accessToken()}&refresh_token=rt-1`)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(RAW_USER)))

    const client = createClient({ url: "http://localhost:9999", anonKey: "anon" })

    expect((await client.auth.getSession()).data.session?.user.id).toBe("user-1")
  })
})

describe("signInWithOAuth checks the provider is enabled", () => {
  const settings = (external: Record<string, boolean>) => jsonResponse({ external, disable_signup: false })

  it("refuses a provider the server has not enabled, before any redirect", async () => {
    const fetch = vi.fn().mockResolvedValue(settings({ github: false, google: true }))
    vi.stubGlobal("fetch", fetch)

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithOAuth({ provider: "github" })

    expect(fetch.mock.calls[0]?.[0]).toBe(`${AUTH_URL}/settings`)
    expect(error?.code).toBe("provider_disabled")
    expect(error?.message).toBe("Sign-in with github is not enabled for this project.")
    expect(data.url).toBe("")
  })

  it("returns the authorize URL for an enabled provider and remembers which one was started", async () => {
    const { store } = stubBrowser("https://app.example/")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(settings({ github: true })))

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithOAuth({ provider: "github" })

    expect(error).toBeNull()
    expect(data.url).toBe(`${AUTH_URL}/authorize?provider=github`)
    expect(store.get(PROVIDER_KEY)).toBe("github")
  })

  it("lets the server decide when the settings cannot be read or do not list the provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")))
    const offline = await new AuthClient(AUTH_URL, HEADERS).signInWithOAuth({ provider: "github" })
    expect(offline.error).toBeNull()

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(settings({ github: false })))
    const custom = await new AuthClient(AUTH_URL, HEADERS).signInWithOAuth({ provider: "custom:acme" })
    expect(custom.error).toBeNull()
    expect(custom.data.url).toContain("provider=custom%3Aacme")
  })
})
