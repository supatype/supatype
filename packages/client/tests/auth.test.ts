import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "../src/auth.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GOTRUE_URL = "http://localhost:9999"
const HEADERS = { apikey: "test-anon-key", "Content-Type": "application/json" }

const RAW_USER = {
  id: "user-1",
  email: "test@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: { name: "Test" },
  role: "authenticated",
}

const TOKEN_RESPONSE = {
  access_token: "access-token-123",
  refresh_token: "refresh-token-abc",
  token_type: "bearer",
  expires_in: 3600,
  user: RAW_USER,
}

function mockFetch(body: unknown, ok = true, status?: number): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok,
    status: status ?? (ok ? 200 : 400),
    json: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  })
}

function freshClient(): AuthClient {
  return new AuthClient(GOTRUE_URL, HEADERS)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AuthClient.signUp()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends POST to /signup", async () => {
    const fetch = mockFetch(TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    const { error } = await freshClient().signUp({ email: "a@b.com", password: "secret" })

    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `${GOTRUE_URL}/signup`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("includes optional user metadata in request body", async () => {
    const fetch = mockFetch(TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    await freshClient().signUp({ email: "a@b.com", password: "s", options: { data: { name: "Alice" } } })

    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body["data"]).toEqual({ name: "Alice" })
  })

  it("returns error on 400", async () => {
    vi.stubGlobal("fetch", mockFetch({ error_description: "Email taken" }, false, 400))

    const { data, error } = await freshClient().signUp({ email: "a@b.com", password: "s" })

    expect(data.session).toBeNull()
    expect(error?.message).toBe("Email taken")
    expect(error?.status).toBe(400)
  })

  it("parses session and user from response", async () => {
    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))

    const { data, error } = await freshClient().signUp({ email: "a@b.com", password: "s" })

    expect(error).toBeNull()
    expect(data.session?.accessToken).toBe("access-token-123")
    expect(data.session?.refreshToken).toBe("refresh-token-abc")
    expect(data.user?.id).toBe("user-1")
    expect(data.user?.email).toBe("test@example.com")
  })
})

describe("AuthClient.signInWithPassword()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends POST to /token?grant_type=password", async () => {
    const fetch = mockFetch(TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    await freshClient().signInWithPassword({ email: "a@b.com", password: "pass" })

    const [url] = fetch.mock.calls[0] as [string, unknown]
    expect(url).toBe(`${GOTRUE_URL}/token?grant_type=password`)
  })

  it("returns error on invalid credentials", async () => {
    vi.stubGlobal("fetch", mockFetch({ error_description: "Invalid login credentials" }, false, 400))

    const { error } = await freshClient().signInWithPassword({ email: "a@b.com", password: "wrong" })

    expect(error?.message).toBe("Invalid login credentials")
    expect(error?.status).toBe(400)
  })

  it("updates internal session state", async () => {
    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))

    const client = freshClient()
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })
    const { data } = await client.getSession()

    expect(data.session?.accessToken).toBe("access-token-123")
  })
})

describe("AuthClient.signInWithOAuth()", () => {
  it("returns redirect URL without making a fetch call", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const { data, error } = await freshClient().signInWithOAuth({ provider: "google" })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(error).toBeNull()
    expect(data.url).toContain("authorize")
    expect(data.url).toContain("provider=google")
    expect(data.provider).toBe("google")
  })

  it("appends redirect_to param when provided", async () => {
    vi.stubGlobal("fetch", vi.fn())

    const { data } = await freshClient().signInWithOAuth({
      provider: "github",
      options: { redirectTo: "http://localhost:3000/auth/callback" },
    })

    expect(data.url).toContain("redirect_to=")
  })
})

describe("AuthClient.signOut()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("calls /logout when a session exists", async () => {
    const client = freshClient()
    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    const logoutFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal("fetch", logoutFetch)
    await client.signOut()

    const [url, opts] = logoutFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${GOTRUE_URL}/logout`)
    expect(opts.method).toBe("POST")
  })

  it("clears session after sign out", async () => {
    const client = freshClient()
    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    await client.signOut()

    const { data } = await client.getSession()
    expect(data.session).toBeNull()
  })

  it("does not call /logout when no session exists", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    await freshClient().signOut()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("AuthClient.onAuthStateChange()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("emits SIGNED_OUT immediately when not signed in", () => {
    const events: string[] = []
    const client = freshClient()
    const { data: { subscription } } = client.onAuthStateChange((event) => events.push(event))

    expect(events).toContain("SIGNED_OUT")
    subscription.unsubscribe()
  })

  it("emits SIGNED_IN after successful sign in", async () => {
    const events: string[] = []
    const client = freshClient()
    const { data: { subscription } } = client.onAuthStateChange((event) => events.push(event))

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    expect(events).toContain("SIGNED_IN")
    subscription.unsubscribe()
  })

  it("emits SIGNED_OUT after sign out", async () => {
    const events: string[] = []
    const client = freshClient()

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    const { data: { subscription } } = client.onAuthStateChange((event) => events.push(event))
    events.length = 0 // clear SIGNED_IN from subscription creation

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    await client.signOut()

    expect(events).toContain("SIGNED_OUT")
    subscription.unsubscribe()
  })

  it("unsubscribe stops future notifications", async () => {
    let callCount = 0
    const client = freshClient()
    const { data: { subscription } } = client.onAuthStateChange(() => callCount++)
    const countAtUnsubscribe = callCount
    subscription.unsubscribe()

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    expect(callCount).toBe(countAtUnsubscribe) // no new calls
  })

  it("multiple listeners each receive events", async () => {
    const events1: string[] = []
    const events2: string[] = []
    const client = freshClient()

    const { data: { subscription: s1 } } = client.onAuthStateChange((e) => events1.push(e))
    const { data: { subscription: s2 } } = client.onAuthStateChange((e) => events2.push(e))

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    expect(events1).toContain("SIGNED_IN")
    expect(events2).toContain("SIGNED_IN")
    s1.unsubscribe()
    s2.unsubscribe()
  })
})

describe("AuthClient.getSession() / getUser()", () => {
  it("getSession returns null when not authenticated", async () => {
    const { data } = await freshClient().getSession()
    expect(data.session).toBeNull()
  })

  it("getUser fetches /user with Authorization header when session exists", async () => {
    const client = freshClient()
    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    const userFetch = mockFetch(RAW_USER)
    vi.stubGlobal("fetch", userFetch)
    const { data, error } = await client.getUser()

    expect(error).toBeNull()
    expect(data.user?.id).toBe("user-1")
    const [, opts] = userFetch.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["Authorization"]).toContain("Bearer access-token-123")
  })
})
