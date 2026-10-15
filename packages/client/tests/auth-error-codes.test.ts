import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthClient } from "../src/auth.js"
import { AuthErrorCodes } from "../src/errors.js"
import { getErrorDocumentation } from "../src/error-codes-doc.js"

// `AuthErrorCodes` held `AUTH_INVALID_CREDENTIALS` and the like, which the auth server never
// sends: it answers `{ error_code: "invalid_credentials", ... }`, and the client passes that code
// through. So `error.code === AuthErrorCodes.INVALID_CREDENTIALS` was false for every wrong
// password. Each constant is checked against the code the server sends in that situation
// (supatype-auth, internal/auth/apierrors/errorcode.go), through the client.

afterEach(() => {
  vi.unstubAllGlobals()
})

const SERVER_SENDS: Array<[keyof typeof AuthErrorCodes, string]> = [
  ["INVALID_CREDENTIALS", "invalid_credentials"],
  ["USER_NOT_FOUND", "user_not_found"],
  ["EMAIL_NOT_CONFIRMED", "email_not_confirmed"],
  ["PHONE_NOT_CONFIRMED", "phone_not_confirmed"],
  ["SESSION_EXPIRED", "session_expired"],
  ["INVALID_TOKEN", "bad_jwt"],
  ["MFA_REQUIRED", "insufficient_aal"],
  ["MFA_CHALLENGE_EXPIRED", "mfa_challenge_expired"],
  ["MFA_VERIFICATION_FAILED", "mfa_verification_failed"],
  ["WEAK_PASSWORD", "weak_password"],
  ["USER_ALREADY_EXISTS", "user_already_exists"],
  ["OAUTH_CALLBACK_ERROR", "bad_oauth_callback"],
  ["MAGIC_LINK_EXPIRED", "otp_expired"],
]

describe("AuthErrorCodes", () => {
  it.each(SERVER_SENDS)("%s is the code the server sends (%s)", async (name, serverCode) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({ code: 400, error_code: serverCode, msg: "refused" }),
        headers: { get: () => null },
      }),
    )
    const client = new AuthClient("http://localhost:9999", { apikey: "k", "Content-Type": "application/json" })
    const { error } = await client.signInWithPassword({ email: "a@example.com", password: "pw" })
    expect(error?.code).toBe(AuthErrorCodes[name])
  })
})

describe("the error documentation", () => {
  it.each(SERVER_SENDS)("has an entry for %s under the code the server sends", (name) => {
    expect(getErrorDocumentation(AuthErrorCodes[name])?.category).toBe("auth")
  })
})
