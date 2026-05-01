/**
 * Provision storage buckets declared in a schema AST via the storage server API.
 *
 * The storage server is the authority on bucket existence — going through the API
 * ensures it creates any backing resources (directories, S3 buckets, etc.).
 * Buckets already registered return 409 Conflict, which is treated as success.
 */

export interface BucketSpec {
  id: string
  public: boolean
  allowed_mime_types?: string[] | null
  file_size_limit?: number | null
  access_mode?: "public" | "private" | "custom"
  s3_bucket_policy?: string | null
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
      public: bucket.public,
      ...(bucket.allowed_mime_types != null && { allowed_mime_types: bucket.allowed_mime_types }),
      ...(bucket.file_size_limit != null && { file_size_limit: bucket.file_size_limit }),
      ...(bucket.access_mode != null && { access_mode: bucket.access_mode }),
      ...(bucket.s3_bucket_policy != null &&
        bucket.s3_bucket_policy !== "" && { s3_bucket_policy: bucket.s3_bucket_policy }),
    })

    const res = await fetch(`${base}/bucket`, { method: "POST", headers, body })
      .catch(() => null)

    if (res === null) continue // server not reachable — skip silently
    if (res.status === 409) continue // already exists — fine
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      console.warn(`[storage] Failed to provision bucket "${bucket.id}": ${msg}`)
    }
  }
}
