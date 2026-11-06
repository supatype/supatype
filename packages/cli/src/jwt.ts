import { createHmac, timingSafeEqual } from "node:crypto"
import { isJsonObject } from "@supatype/shared"

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = base64url(JSON.stringify(payload))
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url")
  return `${header}.${body}.${sig}`
}

/**
 * The claims of an HS256 token signed with `secret`, or null when it is not one: malformed, another
 * algorithm, or a signature that does not match.
 */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const [header, body, sig, ...extra] = token.split(".")
  if (header === undefined || body === undefined || sig === undefined || extra.length > 0) return null
  const expected = Buffer.from(createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url"))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (!isJsonObject(decoded) || decoded["alg"] !== "HS256" || !isJsonObject(claims)) return null
    return claims
  } catch {
    return null
  }
}

export function base64url(str: string): string {
  return Buffer.from(str, "utf8").toString("base64url")
}

/**
 * The `role` claim of a token, read without checking its signature, or undefined when it is not a
 * JWT with one. For telling a service role key from an anon key, never for trusting either.
 */
export function unverifiedJwtRole(token: string): string | undefined {
  const body = token.split(".")[1]
  if (body === undefined) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    return isJsonObject(claims) && typeof claims["role"] === "string" ? claims["role"] : undefined
  } catch {
    return undefined
  }
}
