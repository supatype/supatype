import pg from "pg"
import type { JwtClaims } from "./auth.js"
import type { WalChange } from "./types.js"

const { Pool } = pg

/**
 * RLS-aware event filter.
 *
 * Before sending a change event to a subscriber, we verify they have
 * access to the record by running a SELECT with the subscriber's JWT
 * role set via `set_config('request.jwt.claims', ...)`.
 *
 * This ensures the realtime service respects the same RLS policies
 * that protect the REST API.
 */
export class RlsFilter {
  private pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    })
  }

  /**
   * Check if a user (identified by JWT claims) can see a specific record.
   * Returns true if the record is visible under RLS, false otherwise.
   */
  async canSeeRecord(
    claims: JwtClaims,
    change: WalChange,
  ): Promise<boolean> {
    // For DELETE events, check against the old record's primary key
    const record = change.newRecord ?? change.oldRecord
    if (!record) return false

    // We need at least one column to identify the record
    const pkColumn = this.findPrimaryKeyColumn(record)
    if (!pkColumn) return false

    const client = await this.pool.connect()
    try {
      // Set the JWT claims and role for this transaction
      await client.query("BEGIN")
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify(claims)],
      )
      await client.query(
        `SELECT set_config('role', $1, true)`,
        [claims.role ?? "authenticated"],
      )

      // Attempt to SELECT the record — if RLS blocks it, we get 0 rows
      const result = await client.query(
        `SELECT 1 FROM "${change.schema}"."${change.table}" WHERE "${pkColumn}" = $1 LIMIT 1`,
        [record[pkColumn]],
      )

      await client.query("COMMIT")
      return result.rows.length > 0
    } catch {
      await client.query("ROLLBACK").catch(() => {})
      // If the query fails (e.g., table doesn't exist), deny access
      return false
    } finally {
      client.release()
    }
  }

  /**
   * For DELETE events where the record no longer exists, we can't
   * verify via SELECT. Instead, check if the user has any SELECT
   * permission on the table at all.
   *
   * A more precise approach would cache the last-known visibility,
   * but this is a reasonable first pass.
   */
  async canSeeDelete(
    claims: JwtClaims,
    change: WalChange,
  ): Promise<boolean> {
    // For deletes, we check if the user's role has SELECT on the table
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify(claims)],
      )
      await client.query(
        `SELECT set_config('role', $1, true)`,
        [claims.role ?? "authenticated"],
      )

      const result = await client.query(
        `SELECT has_table_privilege($1, $2, 'SELECT')`,
        [claims.role ?? "authenticated", `"${change.schema}"."${change.table}"`],
      )

      await client.query("COMMIT")
      const row = result.rows[0] as Record<string, unknown> | undefined
      return row?.["has_table_privilege"] === true
    } catch {
      await client.query("ROLLBACK").catch(() => {})
      return false
    } finally {
      client.release()
    }
  }

  /**
   * Check if a subscriber can see a change, dispatching to the
   * appropriate method based on event type.
   */
  async canSee(claims: JwtClaims | null, change: WalChange): Promise<boolean> {
    // Unauthenticated clients can't see anything in secure mode
    if (!claims) return false

    // Service role bypasses RLS
    if (claims.role === "service_role") return true

    if (change.event === "DELETE") {
      return this.canSeeDelete(claims, change)
    }

    return this.canSeeRecord(claims, change)
  }

  async shutdown(): Promise<void> {
    await this.pool.end()
  }

  /** Heuristic: look for 'id' column as primary key. */
  private findPrimaryKeyColumn(record: Record<string, unknown>): string | null {
    if ("id" in record) return "id"
    // Fall back to the first column
    const keys = Object.keys(record)
    return keys[0] ?? null
  }
}
