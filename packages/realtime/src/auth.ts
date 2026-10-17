import jwt, { type JwtPayload } from "jsonwebtoken"

export interface JwtClaims {
  /** Absent from a key that names no user, such as the anon and service-role keys. */
  sub?: string | undefined
  /** Absent from a token that names none: every reader falls back to `authenticated`. */
  role?: string | undefined
  aud?: string | string[] | undefined
  exp?: number | undefined
  iat?: number | undefined
  [key: string]: unknown
}

/** A verified payload's claims, or null when `role` is there and is not a string. */
function claimsOf(payload: JwtPayload): JwtClaims | null {
  const role: unknown = payload["role"]
  if (role !== undefined && typeof role !== "string") return null
  return { ...payload, role }
}

/**
 * Verify and decode a JWT token. Returns the decoded claims or null if invalid.
 */
export function verifyToken(token: string, secret: string): JwtClaims | null {
  try {
    const decoded = jwt.verify(token, secret)
    if (typeof decoded === "string") return null
    return claimsOf(decoded)
  } catch {
    return null
  }
}
