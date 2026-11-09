/**
 * Reading a JWT's claims without verifying it, in a way every runtime the server client reaches
 * supports: `atob` and `TextDecoder` rather than Node's `Buffer`, which edge runtimes do not have.
 * Shared by the cookie parser (a session's expiry) and the Next.js route (a service role token
 * where the anon key belongs).
 */

/** True for a JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Base64 or base64url text decoded as UTF-8. Throws on input that is not base64. */
export function decodeBase64(text: string): string {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

/** The payload of a three-part JWT, or null for anything else. Not verified. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")
  if (payload.length !== 3 || payload[1] === undefined) return null
  try {
    const claims: unknown = JSON.parse(decodeBase64(payload[1]))
    return isJsonObject(claims) ? claims : null
  } catch {
    return null
  }
}
