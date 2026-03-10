import { createHmac } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { config } from "./env.js"

export interface JwtPayload {
  sub: string
  role: string
  aud?: string
  exp?: number
  iat?: number
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
}

/** Decode and verify a HS256 JWT. Returns null if invalid. */
export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null

  const [header, payload, sig] = parts as [string, string, string]

  // Verify signature
  const expected = createHmac("sha256", config.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url")

  if (sig !== expected) return null

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as JwtPayload

    // Check expiry
    if (decoded.exp !== undefined && decoded.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    return decoded
  } catch {
    return null
  }
}

/** Extract JWT from Authorization header or apikey query param. */
export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"]
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  const apikey = req.headers["apikey"]
  if (typeof apikey === "string" && apikey.length > 0) return apikey

  return null
}

/** Authenticate a request. Returns the payload or null for anonymous. */
export function authenticate(req: IncomingMessage): JwtPayload | null {
  const token = extractToken(req)
  if (token === null) return null
  return verifyJwt(token)
}

/** Check if the JWT has service_role. */
export function isServiceRole(jwt: JwtPayload | null): boolean {
  return jwt?.role === "service_role"
}
