import type { JwtClaims } from "../../../src/auth.js"
import type { WalChange } from "../../../src/types.js"

/**
 * The people and rows the suites over an engine-pushed database (`make-db.sh`, from `schema.ts`)
 * share, so a change to the fixture schema is a change in one place.
 */

export const A = "0a0a0a0a-0000-4000-8000-00000000000a"
export const B = "0b0b0b0b-0000-4000-8000-00000000000b"
export const ADMIN = "0d0d0d0d-0000-4000-8000-00000000000d"

export const userA: JwtClaims = { sub: A, role: "authenticated" }
export const userB: JwtClaims = { sub: B, role: "authenticated" }
export const admin: JwtClaims = { sub: ADMIN, role: "authenticated", app_metadata: { role: "admin" } }

/** Bob's `Employee` row: `name` any signed-in user, `salary` admin only, `ssn` Bob only. */
export const bob = { id: B, name: "Bob", salary: 90000, ssn: "B-SSN-222" }

/** The recorded masking tier, the premise each suite checks before it judges anything. */
export const RECORDED_TIER_SQL = `SELECT capabilities->'fieldMasking'->>'tier' AS tier FROM _supatype.schema_state`

/** A change to a `public` table as the WAL decodes it: a DELETE carries the old row, others the new. */
export function change(table: string, event: WalChange["event"], row: Record<string, unknown>): WalChange {
  return {
    schema: "public",
    table,
    event,
    newRecord: event === "DELETE" ? null : row,
    oldRecord: event === "DELETE" ? row : null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
  }
}
