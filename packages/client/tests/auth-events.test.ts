import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "../src/auth.js"
import type { AuthChangeEvent } from "../src/types.js"

const AUTH_URL = "http://localhost:9999"
const HEADERS = { apikey: "test-anon-key", "Content-Type": "application/json" }

const RAW_USER = {
  id: "user-1",
  email: "old@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
  role: "authenticated",
}

const TOKEN_RESPONSE = {
  access_token: "access-token-123",
  refresh_token: "refresh-token-abc",
  token_type: "bearer",
  expires_in: 3600,
  user: RAW_USER,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  } as unknown as Response
}

function accessTokenWithExp(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

/** Every event a listener sees after registration, without the registration emission itself. */
function recordEvents(client: AuthClient): AuthChangeEvent[] {
  const events: AuthChangeEvent[] = []
  let registered = false
  client.onAuthStateChange((event) => {
    if (registered) events.push(event)
  })
  registered = true
  return events
}

async function signedInClient(): Promise<AuthClient> {
  const client = new AuthClient(AUTH_URL, HEADERS)
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(TOKEN_RESPONSE)))
  await client.signInWithPassword({ email: "old@example.com", password: "pw" })
  return client
}

describe("USER_UPDATED", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("is emitted after a successful updateUser, with the updated user on the session", async () => {
    const client = await signedInClient()
    const sessions: Array<string | undefined> = []
    const events: AuthChangeEvent[] = []
    let registered = false
    client.onAuthStateChange((event, session) => {
      if (!registered) return
      events.push(event)
      sessions.push(session?.user.email)
    })
    registered = true

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...RAW_USER, email: "new@example.com" })))
    const { error } = await client.updateUser({ email: "new@example.com" })

    expect(error).toBeNull()
    expect(events).toEqual(["USER_UPDATED"])
    expect(sessions).toEqual(["new@example.com"])
    const { data } = await client.getSession()
    expect(data.session?.user.email).toBe("new@example.com")
    expect(data.session?.accessToken).toBe("access-token-123")
  })

  it("is not emitted when updateUser fails", async () => {
    const client = await signedInClient()
    const events = recordEvents(client)

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ msg: "weak password" }, 422)))
    const { error } = await client.updateUser({ password: "x" })

    expect(error?.status).toBe(422)
    expect(events).toEqual([])
  })
})

describe("PASSWORD_RECOVERY", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("is emitted when a recovery link's tokens are read from the URL", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(RAW_USER)))

    const { error } = await client.getSessionFromUrl(
      `https://app.example/reset#access_token=${accessTokenWithExp()}&refresh_token=rt-1&expires_in=3600&token_type=bearer&type=recovery`,
    )

    expect(error).toBeNull()
    expect(events).toEqual(["SIGNED_IN", "PASSWORD_RECOVERY"])
  })

  it("is not emitted for an ordinary sign-in link", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(RAW_USER)))

    await client.getSessionFromUrl(
      `https://app.example/#access_token=${accessTokenWithExp()}&refresh_token=rt-1&type=magiclink`,
    )

    expect(events).toEqual(["SIGNED_IN"])
  })

  it("is emitted when a recovery OTP is verified", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(TOKEN_RESPONSE)))

    const { error } = await client.verifyOtp({ type: "recovery", token: "123456", email: "old@example.com" })

    expect(error).toBeNull()
    expect(events).toEqual(["SIGNED_IN", "PASSWORD_RECOVERY"])
  })

  it("is not emitted when a recovery OTP is refused", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const events = recordEvents(client)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ msg: "expired" }, 403)))

    await client.verifyOtp({ type: "recovery", token: "123456", email: "old@example.com" })

    expect(events).toEqual([])
  })
})
