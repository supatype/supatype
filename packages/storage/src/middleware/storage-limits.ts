/**
 * Storage limits middleware — Tasks 41-43
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

  // Tier limit from env (set at deploy time) or from tier lookup
  const tierLimit = config.tierMaxUploadSize !== -1
    ? config.tierMaxUploadSize
    : (TIER_UPLOAD_LIMITS[config.projectTier] ?? config.maxUploadSize)

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
  const quota = config.storageQuota !== -1
    ? config.storageQuota
    : (TIER_STORAGE_QUOTAS[config.projectTier] ?? -1)

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
