/**
 * Provision storage buckets declared in a schema AST via the storage server API.
 *
 * The storage server is the authority on bucket existence, going through the API
 * ensures it creates any backing resources (directories, S3 buckets, etc.).
 * Buckets already registered return 409 Conflict, which is treated as success.
 */

import { isArrayOf, isBoolean, isNumber, isOneOf, isShape, isString, nullable, optional, type Guard } from "@supatype/shared"

export type { ExtractedStorageBucketAst as SchemaStorageBucketAst } from "./schema-ast-v2.js"

/**
 * A declared bucket, as the extractor writes it or as the engine's `parse` prints it. The engine
 * prints an unset `Option` as `null`.
 */
export interface ParsedStorageBucket {
  id: string
  /** Absent, with `accessMode`, when the schema names no visibility. */
  public?: boolean
  accessMode?: "public" | "private" | "custom" | null
  allowedMimeTypes?: string[] | null
  fileSizeLimit?: number | null
  s3BucketPolicy?: string | null
}

const isParsedStorageBucket: Guard<ParsedStorageBucket> = isShape({
  id: isString,
  public: optional(isBoolean),
  accessMode: optional(nullable(isOneOf(["public", "private", "custom"] as const))),
  allowedMimeTypes: optional(nullable(isArrayOf(isString))),
  fileSizeLimit: optional(nullable(isNumber)),
  s3BucketPolicy: optional(nullable(isString)),
})

/** The buckets of a schema, as the engine's `parse` prints it. */
export interface ParsedBuckets {
  storageBuckets?: ParsedStorageBucket[] | null
}

export const isParsedBuckets: Guard<ParsedBuckets> = isShape({
  storageBuckets: optional(nullable(isArrayOf(isParsedStorageBucket))),
})

export interface BucketSpec {
  id: string
  /** Absent when the schema names no visibility: the storage service's own default applies. */
  public?: boolean
  allowed_mime_types?: string[] | null
  file_size_limit?: number | null
  access_mode?: "public" | "private" | "custom" | null
  s3_bucket_policy?: string | null
}

export function bucketSpecsFromAst(ast: ParsedBuckets): BucketSpec[] {
  return (ast.storageBuckets ?? []).map((b) => ({
    id: b.id,
    ...(b.public !== undefined && { public: b.public }),
    ...(b.accessMode !== undefined && { access_mode: b.accessMode }),
    ...(b.allowedMimeTypes != null && { allowed_mime_types: b.allowedMimeTypes }),
    ...(b.fileSizeLimit != null && { file_size_limit: b.fileSizeLimit }),
    ...(b.s3BucketPolicy != null &&
      b.s3BucketPolicy !== "" && { s3_bucket_policy: b.s3BucketPolicy }),
  }))
}

export async function provisionBucketsFromAst(
  ast: ParsedBuckets,
  storageApiUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const buckets = bucketSpecsFromAst(ast)
  if (buckets.length === 0) return
  console.log("[supatype] Provisioning storage buckets...")
  await provisionBuckets(storageApiUrl, serviceRoleKey, buckets)
}

/**
 * Ensure all declared buckets exist in the storage server.
 *
 * @param storageApiUrl  Base URL of the storage API, e.g. "http://localhost:54321/storage/v1"
 * @param serviceRoleKey  A service_role JWT for the storage server
 * @param buckets  Buckets to provision (from the resolved AST)
 */
export async function provisionBuckets(
  storageApiUrl: string,
  serviceRoleKey: string,
  buckets: BucketSpec[],
): Promise<void> {
  const base = storageApiUrl.replace(/\/$/, "")
  const headers = {
    "Authorization": `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  }

  for (const bucket of buckets) {
    const body = JSON.stringify({
      id: bucket.id,
      name: bucket.id,
      ...(bucket.public !== undefined && { public: bucket.public }),
      ...(bucket.allowed_mime_types != null && { allowed_mime_types: bucket.allowed_mime_types }),
      ...(bucket.file_size_limit != null && { file_size_limit: bucket.file_size_limit }),
      ...(bucket.access_mode != null && { access_mode: bucket.access_mode }),
      ...(bucket.s3_bucket_policy != null &&
        bucket.s3_bucket_policy !== "" && { s3_bucket_policy: bucket.s3_bucket_policy }),
    })

    const res = await fetch(`${base}/bucket`, { method: "POST", headers, body })
      .catch(() => null)

    if (res === null) {
      console.warn(`[storage] Storage API unreachable, skipped bucket "${bucket.id}"`)
      continue
    }
    if (res.status === 409) continue // already exists, fine
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      console.warn(`[storage] Failed to provision bucket "${bucket.id}": ${msg}`)
      continue
    }
    console.log(`[supatype] Storage bucket "${bucket.id}" ready.`)
  }
}

/**
 * A declared bucket as native dev writes it to the object store's `buckets.json`, created at `now`.
 * `public` follows the access mode, true exactly when it is `public`, as the object store and the
 * storage service write it: a custom bucket declared `public: true` was written public here.
 */
export function nativeBucketRow(bucket: ParsedStorageBucket, now: string): Record<string, unknown> {
  const accessMode = bucket.accessMode ?? (bucket.public ? "public" : "private")
  return {
    id: bucket.id,
    name: bucket.id,
    public: accessMode === "public",
    file_size_limit: bucket.fileSizeLimit ?? null,
    allowed_mime_types: bucket.allowedMimeTypes ?? null,
    access_mode: accessMode,
    s3_bucket_policy: bucket.s3BucketPolicy ?? null,
    created_at: now,
    updated_at: now,
  }
}

/**
 * A `buckets.json` row with `public` brought into line with its access mode. Rows an earlier build
 * wrote keep a custom bucket public otherwise, since the object store only corrects a row when the
 * bucket is next updated. A row with no mode is left as it is: its flag is all it has.
 */
export function withPublicFromMode<T extends Record<string, unknown>>(row: T): T {
  const mode = row["access_mode"]
  if (mode !== "public" && mode !== "private" && mode !== "custom") return row
  return { ...row, public: mode === "public" }
}
