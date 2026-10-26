import { isJsonObject } from "./json.js"

/**
 * The claims in a JWT's payload segment, read without verifying the signature: for `exp`, `role`,
 * `sub` and `aal` on the client's own token. Null when the segment is not base64url-encoded JSON of
 * an object.
 *
 * One decoder for the five places that read a claim. A JWT's segments are base64url, and four of the
 * five passed the segment straight to `atob`, which takes only the standard alphabet: a payload
 * whose encoding contains `-` or `_` (one carrying `>`, `?` or `~`, or any non-ASCII text such as an
 * accented name in the user's metadata) threw, and the claim read as absent.
 */
export function decodeJwtPayload(segment: string): Record<string, unknown> | null {
  try {
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4)
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/")
    const json = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8")
    const claims = JSON.parse(json)
    return isJsonObject(claims) ? claims : null
  } catch {
    return null
  }
}
