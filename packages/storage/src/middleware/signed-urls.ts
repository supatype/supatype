/**
 * Pre-signed URL security — Task 45
 *
 * For private bucket files, generate and validate pre-signed URLs using
 * HMAC-SHA256. These URLs contain:
 * - The bucket and object path
 * - An expiration timestamp
 * - An HMAC-SHA256 signature
 *
 * This provides an alternative to the S3-level pre-signed URLs for
 * application-level URL signing (e.g., for sharing private files via a
 * time-limited link without exposing S3 credentials).
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { config } from "../env.js"

export interface SignedUrlPayload {
  /** Bucket ID */
  b: string
  /** Object path */
  p: string
  /** Expiration time (Unix seconds) */
  exp: number
}

/**
 * Create a signed download token for a private-bucket object.
 *
 * The token is a base64url-encoded JSON payload + HMAC-SHA256 signature,
 * suitable for use as a query parameter.
 *
 * @param bucket - Bucket ID
 * @param objectPath - Object key
 * @param expiresIn - Time to live in seconds (default: config.defaultSignedUrlExpiry)
 * @returns The signed token string
 */
export function createSignedToken(
  bucket: string,
  objectPath: string,
  expiresIn?: number,
): string {
  const ttl = expiresIn ?? config.defaultSignedUrlExpiry
  const clampedTtl = Math.max(1, Math.min(ttl, config.maxSignedUrlExpiry))

  const payload: SignedUrlPayload = {
    b: bucket,
    p: objectPath,
    exp: Math.floor(Date.now() / 1000) + clampedTtl,
  }

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(payloadStr)

  return `${payloadStr}.${signature}`
}

/**
 * Verify a signed token and return the payload if valid.
 *
 * Returns null if the token is malformed, tampered, or expired.
 *
 * @param token - The signed token string (payload.signature)
 * @param expectedBucket - The bucket ID from the URL (must match the token)
 * @param expectedPath - The object path from the URL (must match the token)
 */
export function verifySignedToken(
  token: string,
  expectedBucket: string,
  expectedPath: string,
): SignedUrlPayload | null {
  const dotIndex = token.lastIndexOf(".")
  if (dotIndex === -1) return null

  const payloadStr = token.slice(0, dotIndex)
  const providedSig = token.slice(dotIndex + 1)

  // Verify signature (timing-safe)
  const expectedSig = sign(payloadStr)
  if (!timingSafeCompare(providedSig, expectedSig)) {
    return null
  }

  // Decode payload
  let payload: SignedUrlPayload
  try {
    const decoded = Buffer.from(payloadStr, "base64url").toString("utf8")
    payload = JSON.parse(decoded) as SignedUrlPayload
  } catch {
    return null
  }

  // Validate fields
  if (payload.b !== expectedBucket || payload.p !== expectedPath) {
    return null
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) {
    return null
  }

  return payload
}

/**
 * Create an HMAC-SHA256 signature for a payload string.
 */
function sign(data: string): string {
  return createHmac("sha256", config.signedUrlSecret)
    .update(data)
    .digest("base64url")
}

/**
 * Timing-safe string comparison to prevent timing attacks on signatures.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return timingSafeEqual(bufA, bufB)
}
