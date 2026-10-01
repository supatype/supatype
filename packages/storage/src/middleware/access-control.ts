/**
 * Storage access control: Task 44
 *
 * Who may do what to an object is decided by Postgres, from the RLS policies the engine generates
 * for each bucket's `read`, `create`, `update` and `delete` rules. Writes and deletes run as the
 * caller in `db.ts`. This module only handles the one read that is not a database question: a
 * bucket whose `accessMode` is `public` serves its files to anyone, which is what makes its public
 * URL work.
 *
 * It used to decide writes here too, from `access_mode` alone: any token was enough to upload or
 * delete in every mode, the anon key included, and the declared rules were never consulted.
 */

import type { BucketRow } from "../db.js"
import type { JwtPayload } from "../auth.js"
import * as db from "../db.js"

export type AccessVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string }

/**
 * Check whether a read (download) request is permitted.
 *
 * A `custom` bucket is asked about the same way as a `private` one. It used to allow every signed-in
 * caller through a placeholder, which made "custom" the most permissive mode there was.
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
  if (mode === "public") return { allowed: true }

  if (!jwt) {
    return { allowed: false, status: 401, error: "Authentication required to access this file" }
  }
  if (await db.objectVisibleTo(bucket.id, objectPath, jwt)) return { allowed: true }

  // Not visible: absent, or not theirs to read. Existence is asked with the service's own
  // connection so a missing object still produces the route's 404, rather than a 403 that would
  // confirm nothing is there.
  if (!(await db.getObject(bucket.id, objectPath))) return { allowed: true }
  return { allowed: false, status: 403, error: "You do not have permission to access this file" }
}
