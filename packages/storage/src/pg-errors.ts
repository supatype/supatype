/**
 * Reading what Postgres said, by code rather than by wording.
 *
 * Separate from `db.ts` because that module opens a connection pool and validates configuration
 * the moment it is imported, and none of that is needed to decide what an error means. Held there,
 * the only way to test this was to stand up an environment first.
 */

/** SQLSTATE carried by `pg` on the errors it throws. */
interface PostgresError {
  code?: unknown
}

/**
 * `insufficient_privilege`: the role holds no SELECT on the table.
 *
 * Grants are checked before row level security, so a role without one is refused before any policy
 * is consulted. For this service that means a deployment whose database predates the grants its
 * bucket rules need, which is what an upgrade looks like between pulling new images and running
 * `supatype push`.
 */
export function isMissingGrant(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as PostgresError).code === "42501"
}
