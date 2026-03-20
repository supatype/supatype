/**
 * Storage CORS — Task 46
 *
 * Public buckets: serve with `Access-Control-Allow-Origin: *`
 * Private buckets: no CORS headers (files accessed via pre-signed URLs which
 * are same-origin or programmatic, not browser cross-origin requests).
 */

import type { ServerResponse } from "node:http"
import type { BucketRow } from "../db.js"

/** Standard CORS headers for public bucket responses. */
const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-upsert",
  "Access-Control-Expose-Headers": "Content-Length, Content-Type, ETag",
  "Access-Control-Max-Age": "86400",
}

/** Restricted CORS headers for private bucket responses (no wildcard origin). */
const PRIVATE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-upsert",
}

/**
 * Get the appropriate CORS headers for a bucket.
 *
 * - Public buckets (access_mode: 'public' or public: true): full CORS with `*` origin
 * - Private/custom buckets: limited CORS (no Access-Control-Allow-Origin)
 */
export function getCorsHeaders(bucket: BucketRow | null): Record<string, string> {
  if (!bucket) {
    // Default to public CORS when bucket is unknown (health checks, etc.)
    return PUBLIC_CORS_HEADERS
  }

  const isPublicBucket = bucket.public || bucket.access_mode === "public"
  return isPublicBucket ? PUBLIC_CORS_HEADERS : PRIVATE_CORS_HEADERS
}

/**
 * Apply CORS headers to a response based on bucket configuration.
 */
export function applyCorsHeaders(res: ServerResponse, bucket: BucketRow | null): void {
  const headers = getCorsHeaders(bucket)
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value)
  }
}

/**
 * Get default CORS headers (for routes where no bucket context is available).
 */
export function getDefaultCorsHeaders(): Record<string, string> {
  return PUBLIC_CORS_HEADERS
}
