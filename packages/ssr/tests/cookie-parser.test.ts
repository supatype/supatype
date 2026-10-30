/**
 * The cookie parser runs where the server client runs, edge runtimes included, and those have no
 * Node `Buffer`. Every case here reads the cookie with `Buffer` taken away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseSessionFromCookies } from "../src/cookie-parser.js"

/** base64url of `value`, encoded before `Buffer` is removed. */
const b64url = (value: string): string => Buffer.from(value).toString("base64url")
const b64 = (value: string): string => Buffer.from(value).toString("base64")

/** An unsigned JWT whose `exp` is `offsetSeconds` from now, its payload carrying `name`. */
function jwt(offsetSeconds: number, name: string): string {
  const payload = { sub: "user-1", name, exp: Math.floor(Date.now() / 1000) + offsetSeconds }
  return `e30.${b64url(JSON.stringify(payload))}.sig`
}

/** A session cookie value with no refresh token, so it survives only while its token is live. */
function sessionJson(accessToken: string): string {
  return JSON.stringify({ access_token: accessToken, user: { id: "user-1", user_metadata: { name: "Zoë" } } })
}

describe("parseSessionFromCookies without Buffer", () => {
  // Built while `Buffer` exists; the parser is then run without it.
  let live: string
  let expired: string
  beforeEach(() => {
    // `~?>` and the accented name put `-` and `_` and multi-byte UTF-8 into the base64url payload.
    live = jwt(3600, "Zoë ~?>")
    expired = jwt(-60, "Zoë ~?>")
    vi.stubGlobal("Buffer", undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads a URI-encoded JSON cookie whose token is live", () => {
    const session = parseSessionFromCookies([{ name: "st-auth-token", value: encodeURIComponent(sessionJson(live)) }])
    expect(session).toMatchObject({ accessToken: live, user: { id: "user-1" } })
  })

  it("drops a cookie whose token has expired and has no refresh token", () => {
    const session = parseSessionFromCookies([{ name: "st-auth-token", value: encodeURIComponent(sessionJson(expired)) }])
    expect(session).toBeNull()
  })

  it("reads a base64-encoded JSON cookie, keeping non-ASCII text intact", () => {
    vi.unstubAllGlobals()
    const value = b64(sessionJson(live))
    vi.stubGlobal("Buffer", undefined)
    const session = parseSessionFromCookies([{ name: "st-auth-token", value }])
    expect(session?.user.userMetadata).toEqual({ name: "Zoë" })
  })
})
