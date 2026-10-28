import type { BucketRow } from "./db.js"

/**
 * Whether `bucket` serves its files to anyone, the one read that is not a database question.
 *
 * Decided by `access_mode` alone, which every row has. The public route and CORS used to accept
 * `public` as well, so a `custom` or `private` bucket with a stale `public: true` was served
 * anonymously while every other read refused it.
 */
export function servesAnonymously(bucket: Pick<BucketRow, "access_mode">): boolean {
  return bucket.access_mode === "public"
}
