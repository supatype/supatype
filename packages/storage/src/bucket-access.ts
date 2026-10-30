import type { BucketAccessMode, BucketRow } from "./db.js"

type BucketAccess = Pick<BucketRow, "access_mode" | "public">

/**
 * The bucket's access mode. The schema engine writes no mode for a bucket that declares none, and
 * such a row goes by `public`, as a bucket created without one does.
 */
export function accessModeOf(bucket: BucketAccess): BucketAccessMode {
  return bucket.access_mode ?? (bucket.public ? "public" : "private")
}

/**
 * Whether `bucket` serves its files to anyone, the one read that is not a database question.
 *
 * Decided by the access mode alone. The public route and CORS used to accept `public` as well, so
 * a `custom` or `private` bucket with a stale `public: true` was served anonymously while every
 * other read refused it.
 */
export function servesAnonymously(bucket: BucketAccess): boolean {
  return accessModeOf(bucket) === "public"
}

/**
 * The mode a bucket in `current` has after a write naming `change`. A named mode wins. A `public`
 * flag moves a public or private bucket to the matching mode and leaves a custom one custom, since
 * its rules, not the flag, say who reads it.
 */
export function nextAccessMode(
  current: BucketAccessMode,
  change: { public?: boolean; access_mode?: BucketAccessMode },
): BucketAccessMode {
  if (change.access_mode !== undefined) return change.access_mode
  if (change.public !== undefined && current !== "custom") return change.public ? "public" : "private"
  return current
}
