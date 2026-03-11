import jwt from "jsonwebtoken"

export interface JwtClaims {
  sub: string
  role: string
  aud?: string | undefined
  exp?: number | undefined
  iat?: number | undefined
  [key: string]: unknown
}

/**
 * Verify and decode a JWT token. Returns the decoded claims or null if invalid.
 */
export function verifyToken(token: string, secret: string): JwtClaims | null {
  try {
    const decoded = jwt.verify(token, secret)
    if (typeof decoded === "string") return null
    return decoded as JwtClaims
  } catch {
    return null
  }
}
