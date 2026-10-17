import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "../src/auth.js"
import type { SupatypeError } from "../src/types.js"
import { fetchReturning } from "./support/fetch-mock.js"

const AUTH_URL = "http://localhost:9999"
const HEADERS = { apikey: "test-anon-key", "Content-Type": "application/json" }

const TOKEN_RESPONSE = {
  access_token: "access-token-123",
  refresh_token: "refresh-token-abc",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "user-1", email: "a@example.com", app_metadata: {}, user_metadata: {} },
}

/** What the auth server sends today: a numeric `code`, a string `error_code` and a `msg`. */
const API_ERROR = { code: 422, error_code: "weak_password", msg: "Password should be at least 8 characters." }

/** The OAuth token endpoint's older shape: `error` is the code and `error_description` the message. */
const OAUTH_ERROR = { error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" }

async function signedIn(): Promise<AuthClient> {
  const client = new AuthClient(AUTH_URL, HEADERS)
  vi.stubGlobal("fetch", fetchReturning(TOKEN_RESPONSE, 200))
  await client.signInWithPassword({ email: "a@example.com", password: "pw" })
  return client
}

type AuthCall = (client: AuthClient) => Promise<{ error: SupatypeError | null }>

const CALLS: Array<[string, AuthCall]> = [
  ["signUp", (c) => c.signUp({ email: "a@example.com", password: "x" })],
  ["signInWithPassword", (c) => c.signInWithPassword({ email: "a@example.com", password: "x" })],
  ["signInAnonymously", (c) => c.signInAnonymously()],
  ["signInWithOtp", (c) => c.signInWithOtp({ email: "a@example.com" })],
  ["signInWithIdToken", (c) => c.signInWithIdToken({ provider: "google", token: "t" })],
  ["verifyOtp", (c) => c.verifyOtp({ type: "email", token: "1", email: "a@example.com" })],
  ["resend", (c) => c.resend({ type: "signup", email: "a@example.com" })],
  ["resetPasswordForEmail", (c) => c.resetPasswordForEmail("a@example.com")],
  ["updateUser", (c) => c.updateUser({ password: "x" })],
  ["getUser", (c) => c.getUser()],
  ["refreshSession", (c) => c.refreshSession()],
]

describe("auth errors carry the server's error code", () => {
  beforeEach(() => vi.restoreAllMocks())

  for (const [name, call] of CALLS) {
    it(`${name}: error_code becomes code, msg becomes message`, async () => {
      const client = await signedIn()
      vi.stubGlobal("fetch", fetchReturning(API_ERROR, 422))
      const { error } = await call(client)
      expect(error).toEqual({ message: API_ERROR.msg, status: 422, code: "weak_password" })
    })
  }

  it("the OAuth shape's `error` is the code and `error_description` the message", async () => {
    const client = await signedIn()
    vi.stubGlobal("fetch", fetchReturning(OAUTH_ERROR, 400))
    const { error } = await client.refreshSession()
    expect(error).toEqual({ message: OAUTH_ERROR.error_description, status: 400, code: "invalid_grant" })
  })

  it("a body that is not JSON still gives a message and the status", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const notJson = (): Promise<Response> => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502 }))
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(notJson))
    const { error } = await client.signInWithPassword({ email: "a@example.com", password: "x" })
    expect(error?.status).toBe(502)
    expect(error?.message).not.toBe("")
    expect(error?.code).toBeUndefined()
  })
})

describe("redirect errors carry the server's error code", () => {
  it("getSessionFromUrl keeps error_code from an expired email link", async () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const { error } = await client.getSessionFromUrl(
      "https://app.example/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    )
    expect(error).toEqual({ message: "Email link is invalid or has expired", status: 400, code: "otp_expired" })
  })
})
