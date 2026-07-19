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

describe("AuthClient.signInAnonymously()", () => {
  beforeEach(() => vi.restoreAllMocks())

  const ANON_USER = {
    ...RAW_USER,
    email: undefined,
    is_anonymous: true,
  }

  const ANON_TOKEN_RESPONSE = {
    ...TOKEN_RESPONSE,
    user: ANON_USER,
  }

  it("sends POST to /signup with no email or password", async () => {
    const fetch = mockFetch(ANON_TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    const { error } = await freshClient().signInAnonymously()

    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `${GOTRUE_URL}/signup`,
      expect.objectContaining({ method: "POST" }),
    )
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body["email"]).toBeUndefined()
    expect(body["password"]).toBeUndefined()
  })

  it("includes optional user metadata and captcha token", async () => {
    const fetch = mockFetch(ANON_TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    await freshClient().signInAnonymously({
      options: { data: { guest: true }, captchaToken: "captcha-123" },
    })

    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body["data"]).toEqual({ guest: true })
    expect(body["gotrue_meta_security"]).toEqual({ captcha_token: "captcha-123" })
  })

  it("parses isAnonymous from response", async () => {
    vi.stubGlobal("fetch", mockFetch(ANON_TOKEN_RESPONSE))

    const { data, error } = await freshClient().signInAnonymously()

    expect(error).toBeNull()
    expect(data.user?.isAnonymous).toBe(true)
    expect(data.session?.accessToken).toBe("access-token-123")
  })

  it("returns error when anonymous sign-ins are disabled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ msg: "Anonymous sign-ins are disabled" }, false, 422),
    )

    const { data, error } = await freshClient().signInAnonymously()

    expect(data.session).toBeNull()
    expect(error?.message).toBe("Anonymous sign-ins are disabled")
    expect(error?.status).toBe(422)
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

describe("AuthClient.refreshSession()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("clears session and emits SIGNED_OUT when refresh fails", async () => {
    const events: string[] = []
    const client = freshClient()
    client.onAuthStateChange((event) => events.push(event))

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })
    events.length = 0

    vi.stubGlobal("fetch", mockFetch({ error_description: "Invalid Refresh Token" }, false, 400))
    const { data, error } = await client.refreshSession()

    expect(error?.message).toBe("Invalid Refresh Token")
    expect(data.session).toBeNull()
    const { data: sessionAfter } = await client.getSession()
    expect(sessionAfter.session).toBeNull()
    expect(events).toContain("SIGNED_OUT")
  })
})

describe("AuthClient custom storage", () => {
  beforeEach(() => vi.restoreAllMocks())

  const VALID_SESSION = {
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    tokenType: "bearer",
    expiresIn: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: "user-1",
      email: "test@example.com",
      appMetadata: { provider: "email" },
      userMetadata: { name: "Test" },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  }

  it("hydrates session from async storage and emits SIGNED_IN", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(JSON.stringify(VALID_SESSION)),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const events: string[] = []
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })
    client.onAuthStateChange((event) => events.push(event))

    await client.whenReady()
    const { data } = await client.getSession()

    expect(data.session?.accessToken).toBe("stored-access")
    expect(events).toContain("SIGNED_IN")
  })

  it("persists session to custom storage on sign in", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })
    await client.whenReady()

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    await client.signInWithPassword({ email: "a@b.com", password: "pass" })

    expect(storage.setItem).toHaveBeenCalled()
    const [key, value] = storage.setItem.mock.calls[0] as [string, string]
    expect(key).toBe("supatype.auth.session")
    expect(JSON.parse(value).accessToken).toBe("access-token-123")
  })

  it("survives corrupt async storage without throwing", async () => {
    const storage = {
      getItem: vi.fn().mockRejectedValue(new Error("storage unavailable")),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })

    await expect(client.whenReady()).resolves.toBeUndefined()
    const { data } = await client.getSession()
    expect(data.session).toBeNull()
  })

  it("does not read storage when persistSession is false", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(JSON.stringify(VALID_SESSION)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage, persistSession: false })
    await client.whenReady()

    expect(storage.getItem).not.toHaveBeenCalled()
    const { data } = await client.getSession()
    expect(data.session).toBeNull()
  })
})

describe("AuthClient OAuth session completion", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("signInWithOAuth defaults to implicit (no PKCE params)", async () => {
    const { data, error } = await freshClient().signInWithOAuth({ provider: "google" })
    expect(error).toBeNull()
    const url = new URL(data.url)
    expect(url.searchParams.get("provider")).toBe("google")
    expect(url.searchParams.get("code_challenge")).toBeNull()
    expect(url.searchParams.get("code_challenge_method")).toBeNull()
  })

  it("signInWithOAuth pkce appends challenge and persists verifier", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })
    await client.whenReady()

    const { data, error } = await client.signInWithOAuth({
      provider: "github",
      options: { flowType: "pkce", redirectTo: "myapp://auth/callback" },
    })

    expect(error).toBeNull()
    const url = new URL(data.url)
    expect(url.searchParams.get("code_challenge_method")).toBe("s256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(url.searchParams.get("redirect_to")).toBe("myapp://auth/callback")
    expect(storage.setItem).toHaveBeenCalledWith(
      "supatype.auth.session-code-verifier",
      expect.stringMatching(/^[A-Za-z0-9\-._~]+$/),
    )
  })

  it("exchangeCodeForSession posts auth_code + code_verifier", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })
    await client.whenReady()
    await client.signInWithOAuth({ provider: "google", options: { flowType: "pkce" } })

    const fetch = mockFetch(TOKEN_RESPONSE)
    vi.stubGlobal("fetch", fetch)

    const { data, error } = await client.exchangeCodeForSession("auth-code-xyz")

    expect(error).toBeNull()
    expect(data.session?.accessToken).toBe("access-token-123")
    expect(fetch).toHaveBeenCalledWith(
      `${GOTRUE_URL}/token?grant_type=pkce`,
      expect.objectContaining({ method: "POST" }),
    )
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as Record<string, unknown>
    expect(body["auth_code"]).toBe("auth-code-xyz")
    expect(typeof body["code_verifier"]).toBe("string")
    expect(storage.removeItem).toHaveBeenCalledWith("supatype.auth.session-code-verifier")
  })

  it("getSessionFromUrl exchanges PKCE code from query", async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const client = new AuthClient(GOTRUE_URL, HEADERS, { storage })
    await client.whenReady()
    await client.signInWithOAuth({ provider: "google", options: { flowType: "pkce" } })

    vi.stubGlobal("fetch", mockFetch(TOKEN_RESPONSE))
    const { data, error } = await client.getSessionFromUrl(
      "myapp://auth/callback?code=returned-auth-code",
    )

    expect(error).toBeNull()
    expect(data.session?.accessToken).toBe("access-token-123")
  })

  it("getSessionFromUrl sets session from implicit hash tokens", async () => {
    const client = freshClient()
    // Minimal JWT-ish payload with exp so setSession can decode (header.payload.sig)
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      "base64url",
    )
    const accessToken = `eyJhbGciOiJub25lIn0.${payload}.sig`

    vi.stubGlobal(
      "fetch",
      mockFetch({
        ...RAW_USER,
        id: "user-1",
      }),
    )

    const { data, error } = await client.getSessionFromUrl(
      `https://app.example/#access_token=${accessToken}&refresh_token=rt-1&token_type=bearer&expires_in=3600`,
    )

    expect(error).toBeNull()
    expect(data.session?.accessToken).toBe(accessToken)
    expect(data.session?.refreshToken).toBe("rt-1")
    expect(data.user?.id).toBe("user-1")
  })

  it("getSessionFromUrl returns error from redirect query", async () => {
    const { data, error } = await freshClient().getSessionFromUrl(
      "myapp://auth/callback?error=access_denied&error_description=User+denied",
    )
    expect(data.session).toBeNull()
    expect(error?.message).toBe("User denied")
  })

  it("exchangeCodeForSession errors when verifier is missing", async () => {
    const { data, error } = await freshClient().exchangeCodeForSession("code")
    expect(data.session).toBeNull()
    expect(error?.message).toMatch(/code_verifier/)
  })
})

describe("AuthClient stale persisted session", () => {
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

  it("getSession clears persisted session when refresh fails for expired token", async () => {
    const expiredSession = {
      access_token: "old-access",
      refresh_token: "old-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: RAW_USER,
    }
    store.set("supatype.auth.session", JSON.stringify(expiredSession))

    const events: string[] = []
    const client = new AuthClient(GOTRUE_URL, HEADERS)
    client.onAuthStateChange((event) => events.push(event))

    vi.stubGlobal("fetch", mockFetch({ error_description: "Invalid Refresh Token" }, false, 400))
    const { data } = await client.getSession()

    expect(data.session).toBeNull()
    expect(store.get("supatype.auth.session")).toBeUndefined()
    expect(events).toContain("SIGNED_OUT")
  })
})
