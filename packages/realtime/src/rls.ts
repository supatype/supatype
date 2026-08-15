import pg from "pg"
import type { JwtClaims } from "./auth.js"
import type { WalChange } from "./types.js"
import {
  FieldMaskCatalog,
  maskRecord,
  quotePredicateRef,
  type PredicateRef,
  type ReadMasks,
} from "./field-mask.js"

const { Pool } = pg

/** Identifiers reach SQL quoted, never interpolated bare. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

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
  private fieldMasks: FieldMaskCatalog

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    })
    this.pool.on("error", (err) => {
      console.error("[realtime] rls pool error:", err)
    })
    this.fieldMasks = new FieldMaskCatalog(this.pool)
  }

  /** Drop the cached field rules — called when a schema push completes. */
  invalidateFieldMasks(): void {
    this.fieldMasks.invalidate()
  }

  /** Which columns of a table carry a read restriction, for filter safety checks. */
  async maskedColumns(schema: string, table: string): Promise<Set<string>> {
    try {
      return new Set((await this.fieldMasks.readMasks(schema, table)).keys())
    } catch {
      // Unknown means "treat every filter as unsafe", which costs a round trip rather
      // than leaking one.
      return new Set(["*"])
    }
  }

  /**
   * Whether a subscriber may see a change, and what it looks like once their field rules
   * are applied.
   *
   * Returns the change to send, or `null` to drop it. Deliberately not a boolean plus a
   * separate masking step: the only value a caller can obtain is the masked one, so a
   * dispatch path cannot forget to mask and send the real column instead.
   *
   * Row visibility and field verdicts share one transaction, so a subscriber is judged
   * once per change against one snapshot with one set of claims.
   */
  async visibleChange(
    claims: JwtClaims | null,
    change: WalChange,
  ): Promise<WalChange | null> {
    // Unauthenticated clients can't see anything in secure mode
    if (!claims) return null

    // Service role bypasses RLS, and is the role `supatype_mask` exempts too
    if (claims.role === "service_role") return change

    let masks: ReadMasks
    try {
      masks = await this.fieldMasks.readMasks(change.schema, change.table)
    } catch {
      // Not knowing which columns are restricted means not being able to send any of
      // them safely.
      return null
    }

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

      const visible =
        change.event === "DELETE"
          ? await this.deleteVisible(client, claims, change)
          : await this.recordVisible(client, change)

      if (!visible) {
        await client.query("COMMIT")
        return null
      }

      const masked = masks.size === 0 ? change : await this.applyMasks(client, change, masks)
      await client.query("COMMIT")
      return masked
    } catch {
      await client.query("ROLLBACK").catch(() => {})
      // If anything fails (table gone, predicate missing, a value that will not round-trip
      // through jsonb), drop the event. A dropped event is recoverable; a leaked column is
      // not.
      return null
    } finally {
      client.release()
    }
  }

  /**
   * Judge each restricted column against the WAL record itself, cast to the table's
   * composite type.
   *
   * Not by re-reading the row: the current row may already differ from the one the event
   * describes, and for a DELETE there is no row left to read. Building the composite from
   * the record makes the answer race-free and uniform across INSERT, UPDATE and DELETE.
   *
   * `old` and `new` are judged separately. An UPDATE that changes ownership flips the
   * verdict between them, and the old value is exactly the one worth protecting.
   */
  private async applyMasks(
    client: pg.PoolClient,
    change: WalChange,
    masks: ReadMasks,
  ): Promise<WalChange> {
    const columns = [...masks.keys()]
    const sides: Array<{ key: "new" | "old"; alias: string; record: Record<string, unknown> }> = []
    if (change.newRecord) sides.push({ key: "new", alias: "n", record: change.newRecord })
    if (change.oldRecord) sides.push({ key: "old", alias: "o", record: change.oldRecord })
    if (sides.length === 0) return change

    // Columns whose label could not be parsed are masked without asking.
    const askable = columns.filter((column) => masks.get(column) != null)

    const verdicts = new Map<string, Map<string, boolean | null>>()
    for (const side of sides) verdicts.set(side.key, new Map())

    if (askable.length > 0) {
      const relation = `${quoteIdentifier(change.schema)}.${quoteIdentifier(change.table)}`
      const from = sides.map(
        (side, index) =>
          `jsonb_populate_record(null::${relation}, $${index + 1}::jsonb) AS ${side.alias}`,
      )
      const terms: string[] = []
      askable.forEach((column, columnIndex) => {
        const predicate = quotePredicateRef(masks.get(column) as PredicateRef)
        for (const side of sides) {
          terms.push(`${predicate}(${side.alias}) AS ${side.alias}_${columnIndex}`)
        }
      })

      const result = await client.query(
        `SELECT ${terms.join(", ")} FROM ${from.join(", ")}`,
        sides.map((side) => JSON.stringify(side.record)),
      )
      const row = (result.rows[0] ?? {}) as Record<string, unknown>

      askable.forEach((column, columnIndex) => {
        for (const side of sides) {
          const value = row[`${side.alias}_${columnIndex}`]
          verdicts.get(side.key)!.set(column, value === true ? true : null)
        }
      })
    }

    return {
      ...change,
      newRecord: maskRecord(change.newRecord, columns, verdicts.get("new") ?? new Map()),
      oldRecord: maskRecord(change.oldRecord, columns, verdicts.get("old") ?? new Map()),
    }
  }

  /**
   * Row visibility for INSERT and UPDATE: re-select the row under the subscriber's role.
   *
   * Still a re-read rather than a generated `can_read_<table>` call, because the stored
   * policies are authoritative and may include hand-written ones no generated function
   * knows about. The field verdicts above are a different question — those have no
   * policy to defer to.
   */
  private async recordVisible(client: pg.PoolClient, change: WalChange): Promise<boolean> {
    const record = change.newRecord ?? change.oldRecord
    if (!record) return false

    const pkColumn = this.findPrimaryKeyColumn(record)
    if (!pkColumn) return false

    const result = await client.query(
      `SELECT 1 FROM ${quoteIdentifier(change.schema)}.${quoteIdentifier(change.table)} ` +
        `WHERE ${quoteIdentifier(pkColumn)} = $1 LIMIT 1`,
      [record[pkColumn]],
    )
    return result.rows.length > 0
  }

  /**
   * For DELETE the row is gone, so there is nothing to re-select. Falls back to "does this
   * role hold SELECT on the table at all".
   *
   * Known coarseness, pre-existing and unchanged here: a subscriber who may read *some*
   * rows sees *every* delete on the table. Field masking now applies to those payloads, so
   * a restricted column is no longer disclosed by one — but which deletes a caller learns
   * about is still broader than RLS would allow, and closing it needs last-known-visibility
   * tracking rather than a query.
   */
  private async deleteVisible(
    client: pg.PoolClient,
    claims: JwtClaims,
    change: WalChange,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT has_table_privilege($1, $2, 'SELECT')`,
      [claims.role ?? "authenticated", `"${change.schema}"."${change.table}"`],
    )
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row?.["has_table_privilege"] === true
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
