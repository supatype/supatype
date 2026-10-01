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

function hasSqlState(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as PostgresError).code === code
}

/** `unique_violation`: the object is already there. */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, "23505")
}

/**
 * `insufficient_privilege`, read as a row level security refusal.
 *
 * Postgres raises the same SQLSTATE for a policy that refuses a row and for a role that holds no
 * grant on the table at all, and the two mean opposite things here: one is the bucket's rule
 * working, the other is a deployment whose database predates the grants, which `supatype push`
 * fixes. So this is only a policy refusal where the grants were confirmed first, which is what
 * `db.ts` does before every write.
 */
export function isPolicyViolation(err: unknown): boolean {
  return hasSqlState(err, "42501")
}
