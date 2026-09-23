/**
 * The marker the engine stamps on every database object it owns.
 *
 * Mirrors the engine's own prefix. It is what lets the differ tell an object it created from one
 * somebody added by hand, and it is worth surfacing for the same reason: an object without it will
 * not be maintained by a push, and will not be dropped by one either.
 */
const MANAGED_PREFIX = "supatype:managed"

/** Whether a `COMMENT ON` value marks the object as one Supatype maintains. */
export function isManaged(comment: unknown): boolean {
  return typeof comment === "string" && comment.startsWith(MANAGED_PREFIX)
}
