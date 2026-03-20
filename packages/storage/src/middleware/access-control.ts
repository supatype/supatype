/**
 * Storage access control — Task 44
 *
 * Bucket access modes:
 * - 'public':  Anyone can read. Authenticated users can upload.
 * - 'private': Only the object owner can read/write.
 * - 'custom':  RLS-like rules evaluated per-request (placeholder for custom policies).
 *
 * The access mode is stored on the bucket row (inferred from schema access rules
 * at deploy time by the schema provisioner).
 */

import type { BucketRow } from "../db.js"
import type { JwtPayload } from "../auth.js"
import * as db from "../db.js"

export type AccessVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string }

// ─── Read access ─────────────────────────────────────────────────────────────

/**
 * Check whether a read (download) request is permitted.
 *
 * @param bucket - The target bucket
 * @param objectPath - Object key within the bucket
 * @param jwt - The caller's JWT (null for anonymous)
 */
export async function checkReadAccess(
  bucket: BucketRow,
  objectPath: string,
  jwt: JwtPayload | null,
): Promise<AccessVerdict> {
  const mode = bucket.access_mode ?? (bucket.public ? "public" : "private")

  switch (mode) {
    case "public":
      // Anyone may read
      return { allowed: true }

    case "private": {
      if (!jwt) {
        return { allowed: false, status: 401, error: "Authentication required to access this file" }
      }
      // Owner check: the object must be owned by the requesting user
      const obj = await db.getObject(bucket.id, objectPath)
      if (!obj) {
        // Let the caller return 404 naturally
        return { allowed: true }
      }
      if (obj.owner !== jwt.sub) {
        return {
          allowed: false,
          status: 403,
          error: "You do not have permission to access this file",
        }
      }
      return { allowed: true }
    }

    case "custom": {
      // Custom access mode: for now, require authentication.
      // A full implementation would evaluate RLS-like policies stored per bucket.
      if (!jwt) {
        return { allowed: false, status: 401, error: "Authentication required" }
      }
      // Placeholder: custom policies would be evaluated here.
      // For service_role tokens, always allow.
      if (jwt.role === "service_role") {
        return { allowed: true }
      }
      // Default: allow authenticated users (real custom policies are a follow-up).
      return { allowed: true }
    }

    default:
      return { allowed: true }
  }
}

// ─── Write (upload) access ───────────────────────────────────────────────────

/**
 * Check whether a write (upload/delete) request is permitted.
 *
 * @param bucket - The target bucket
 * @param jwt - The caller's JWT (null for anonymous)
 */
export function checkWriteAccess(
  bucket: BucketRow,
  jwt: JwtPayload | null,
): AccessVerdict {
  const mode = bucket.access_mode ?? (bucket.public ? "public" : "private")

  // All write modes require authentication
  if (!jwt) {
    return { allowed: false, status: 401, error: "Authentication required to upload files" }
  }

  // service_role always allowed
  if (jwt.role === "service_role") {
    return { allowed: true }
  }

  switch (mode) {
    case "public":
      // Any authenticated user can upload to public buckets
      return { allowed: true }

    case "private":
      // Any authenticated user can upload (they become the owner).
      // Overwriting someone else's object is blocked in the upload handler.
      return { allowed: true }

    case "custom":
      // Placeholder for custom policy evaluation
      return { allowed: true }

    default:
      return { allowed: true }
  }
}

/**
 * For private buckets, check if the current user is allowed to overwrite
 * an existing object (they must be the owner or have service_role).
 */
export async function checkOverwriteAccess(
  bucket: BucketRow,
  objectPath: string,
  jwt: JwtPayload,
): Promise<AccessVerdict> {
  const mode = bucket.access_mode ?? (bucket.public ? "public" : "private")

  if (mode !== "private") return { allowed: true }
  if (jwt.role === "service_role") return { allowed: true }

  const existing = await db.getObject(bucket.id, objectPath)
  if (!existing) return { allowed: true } // new object, allowed

  if (existing.owner !== jwt.sub) {
    return {
      allowed: false,
      status: 403,
      error: "You do not have permission to overwrite this file",
    }
  }

  return { allowed: true }
}
