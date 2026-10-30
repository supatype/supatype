/**
 * Storage limits middleware: Tasks 41-43
 *
 * Enforces:
 * - Per-file upload size limits (task 41): bucket-level + tier-level
 * - Storage quota (task 42): total project storage check
 * - Allowed file types (task 43): Content-Type validation against bucket config
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { BucketRow } from "../db.js"
import { config } from "../env.js"
import { sendJson } from "../server.js"
import * as db from "../db.js"

// ─── Tier per-file upload limits (bytes) ─────────────────────────────────────

const TIER_UPLOAD_LIMITS: Record<string, number> = {
  free: 50 * 1024 * 1024,         // 50 MB
  pro: 250 * 1024 * 1024,         // 250 MB
  team: 1024 * 1024 * 1024,       // 1 GB
  enterprise: -1,                  // unlimited
}

// ─── Tier storage quotas (bytes) ─────────────────────────────────────────────

const TIER_STORAGE_QUOTAS: Record<string, number> = {
  free: 1024 * 1024 * 1024,                // 1 GB
  pro: 50 * 1024 * 1024 * 1024,            // 50 GB
  team: 500 * 1024 * 1024 * 1024,          // 500 GB
  enterprise: -1,                           // unlimited
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Determine the effective max upload size for a single file.
 *
 * Priority: bucket.file_size_limit > tier limit > global config.maxUploadSize
 */
export function getEffectiveMaxUploadSize(bucket: BucketRow): number {
  // Bucket-specific limit takes priority (from schema field.image({ maxSize }))
  if (bucket.file_size_limit !== null) {
    return bucket.file_size_limit
  }

  // Tier limit from env (set at deploy time), else from tier lookup. An explicit -1 sets none; it
  // used to mean "look the tier up", so a self-hosted -1 still got the free tier's 50 MB.
  const tierLimit = config.tierMaxUploadSize ?? TIER_UPLOAD_LIMITS[config.projectTier] ?? -1

  if (tierLimit !== -1) return tierLimit

  // Global default
  return config.maxUploadSize
}

/**
 * Validate file size against per-bucket and per-tier limits.
 *
 * Returns an error response object if the file is too large, or null if OK.
 */
export function validateFileSize(
  bucket: BucketRow,
  bodyLength: number,
): { status: 413; body: { error: string } } | null {
  const maxSize = getEffectiveMaxUploadSize(bucket)

  if (maxSize !== -1 && bodyLength > maxSize) {
    return {
      status: 413,
      body: {
        error: `File size ${formatBytes(bodyLength)} exceeds the maximum allowed size of ${formatBytes(maxSize)}`,
      },
    }
  }

  return null
}

/** The 413 for an upload whose body passed the bucket's limit before it ended, at a size not known. */
export function oversizeRefusal(bucket: BucketRow): { status: 413; body: { error: string } } {
  const maxSize = getEffectiveMaxUploadSize(bucket)
  return { status: 413, body: { error: `File size exceeds the maximum allowed size of ${formatBytes(maxSize)}` } }
}

/**
 * Validate Content-Type against bucket's allowed MIME types.
 *
 * Supports exact matches ('image/jpeg') and wildcard matches ('image/*').
 * Returns an error response object if the type is not allowed, or null if OK.
 */
export function validateContentType(
  bucket: BucketRow,
  contentType: string,
): { status: 415; body: { error: string; allowed: string[] } } | null {
  if (!bucket.allowed_mime_types || bucket.allowed_mime_types.length === 0) {
    return null
  }

  const normalised = contentType.split(";")[0]!.trim().toLowerCase()

  const allowed = bucket.allowed_mime_types.some((mime) => {
    const m = mime.toLowerCase()
    if (m.endsWith("/*")) {
      // Wildcard: 'image/*' matches 'image/jpeg'
      return normalised.startsWith(m.slice(0, -1))
    }
    return normalised === m
  })

  if (!allowed) {
    return {
      status: 415,
      body: {
        error: `Content type '${normalised}' is not allowed for bucket '${bucket.name}'. Allowed types: ${bucket.allowed_mime_types.join(", ")}`,
        allowed: bucket.allowed_mime_types,
      },
    }
  }

  return null
}

/**
 * Check whether accepting a file of the given size would exceed the project's
 * total storage quota.
 *
 * Returns an error response object if quota would be exceeded, or null if OK.
 */
export async function validateStorageQuota(
  incomingBytes: number,
): Promise<{ status: 507; body: { error: string; usage: number; quota: number } } | null> {
  // An explicit -1 is unlimited; it used to fall back to the tier table, so it never was.
  const quota = config.storageQuota ?? TIER_STORAGE_QUOTAS[config.projectTier] ?? -1

  // -1 means unlimited
  if (quota === -1) return null

  const currentUsage = await db.getTotalStorageUsage()
  const projectedUsage = currentUsage + incomingBytes

  if (projectedUsage > quota) {
    return {
      status: 507,
      body: {
        error: `Storage quota exceeded. Current usage: ${formatBytes(currentUsage)}, quota: ${formatBytes(quota)}. Upgrade your plan to increase storage.`,
        usage: currentUsage,
        quota,
      },
    }
  }

  return null
}

/** The empty object Studio (and Supabase's dashboard) writes to hold a new folder open. */
export const FOLDER_PLACEHOLDER = ".emptyFolderPlaceholder"

/**
 * An empty object named as a folder's placeholder. It holds no file, so a bucket's file types do
 * not apply to it: a bucket limited to images refused it, and with it every new folder. Only an
 * empty one, as Supabase does, so the name cannot carry content of a type the bucket refuses.
 */
export function isFolderPlaceholder(objectPath: string, bodyLength: number): boolean {
  if (bodyLength !== 0) return false
  return objectPath === FOLDER_PLACEHOLDER || objectPath.endsWith(`/${FOLDER_PLACEHOLDER}`)
}

/** Why the bucket and the project refuse this upload, by type, size and quota; null when they accept it. */
export async function uploadRefusal(
  bucket: BucketRow,
  upload: { objectPath: string; contentType: string; bodyLength: number },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const typeError = isFolderPlaceholder(upload.objectPath, upload.bodyLength)
    ? null
    : validateContentType(bucket, upload.contentType)
  return typeError ?? validateFileSize(bucket, upload.bodyLength) ?? await validateStorageQuota(upload.bodyLength)
}
