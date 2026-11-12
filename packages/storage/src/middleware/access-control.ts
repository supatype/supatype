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
import { servesAnonymously } from "../bucket-access.js"

export type AccessVerdict =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 404; error: string }

/**
 * Check whether a read (download or sign) request is permitted.
 *
 * A `custom` bucket is asked about the same way as a `private` one. It used to allow every signed-in
 * caller through a placeholder, which made "custom" the most permissive mode there was.
 *
 * Not allowed is 404 or 403 by what the caller's read rule allows (`db.readVerdict`), never by
 * whether the object exists: the existence check used to run on the service's own connection, so
 * the anon key got 404 for a missing name and 403 for a present one in a private bucket.
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
  if (servesAnonymously(bucket)) return { allowed: true }

  if (!jwt) {
    return { allowed: false, status: 401, error: "Authentication required to access this file" }
  }
  switch (await db.readVerdict(bucket.id, objectPath, jwt)) {
    case "visible":
      return { allowed: true }
    case "hidden":
      return { allowed: false, status: 404, error: "Object not found" }
    case "refused":
      return { allowed: false, status: 403, error: "You do not have permission to access this file" }
  }
}
