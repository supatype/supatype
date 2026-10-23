/**
 * What the auth admin API said when it refused, in its own words. The auth server answers with
 * `msg`, its OAuth endpoints with `error_description` beside a bare `error` code, and the Studio
 * guard in front of it with `error` alone ("Only a Studio admin can change another admin's
 * account."). Every Studio caller of that API reads the refusal here, so none of them throws the
 * sentence away for a generic one.
 */
const REFUSAL_KEYS = ["msg", "message", "error_description", "error"] as const

/** The refusal's sentence, or undefined when the body carries none. */
export function authRefusalText(body: Record<string, unknown>): string | undefined {
  for (const key of REFUSAL_KEYS) {
    const value = body[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}
