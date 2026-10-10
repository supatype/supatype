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
import { TableCatalog, type TableShape } from "./table-catalog.js"
import { logDrop, sqlState, type DropSeverity } from "./drop-log.js"

const { Pool } = pg

/** Identifiers reach SQL quoted, never interpolated bare. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function relationOf(change: WalChange): string {
  return `${quoteIdentifier(change.schema)}.${quoteIdentifier(change.table)}`
}

/** Why a change was withheld from a subscriber. */
interface Refusal {
  severity: DropSeverity
  reason: string
}

type Verdict = { send: WalChange } | Refusal

const denied = (reason: string): Refusal => ({ severity: "denied", reason })
const failed = (reason: string): Refusal => ({ severity: "failed", reason })

/** What a table's changes are judged with, read before the subscriber's transaction opens. */
interface TableRules {
  masks: ReadMasks
  shape: TableShape
}

/**
 * RLS-aware event filter.
 *
 * Before sending a change event to a subscriber, we verify they have access to the record as the
 * subscriber's role, with their JWT claims set via `set_config('request.jwt.claims', ...)`, so
 * realtime respects the same rules that protect the REST API.
 */
export class RlsFilter {
  private pool: pg.Pool
  private fieldMasks: FieldMaskCatalog
  private tables: TableCatalog

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    })
    this.pool.on("error", (err) => {
      console.error("[realtime] rls pool error:", err)
    })
    this.fieldMasks = new FieldMaskCatalog(this.pool)
    this.tables = new TableCatalog(this.pool)
  }

  /** Drop the cached field rules and table shapes, called when a schema push completes. */
  invalidateCatalogs(): void {
    this.fieldMasks.invalidate()
    this.tables.invalidate()
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
   * Every drop is logged with its reason (see `drop-log.ts`), never with row data.
   */
  async visibleChange(
    claims: JwtClaims | null,
    change: WalChange,
  ): Promise<WalChange | null> {
    const verdict = await this.judge(claims, change)
    if ("send" in verdict) return verdict.send
    logDrop(
      {
        schema: change.schema,
        table: change.table,
        event: change.event,
        role: claims ? (claims.role ?? "authenticated") : "none",
        reason: verdict.reason,
      },
      verdict.severity,
    )
    return null
  }

  private async judge(claims: JwtClaims | null, change: WalChange): Promise<Verdict> {
    // Unauthenticated clients can't see anything in secure mode
    if (!claims) return denied("unauthenticated subscriber")

    // Service role bypasses RLS, and is the role `supatype_mask` exempts too
    if (claims.role === "service_role") return { send: change }

    const rules = await this.rulesFor(change)
    if ("reason" in rules) return rules
    return this.judgeAsSubscriber(claims, change, rules)
  }

  /**
   * The table's field rules and shape. Not knowing either means not being able to judge the
   * change safely, so a failure here drops it.
   */
  private async rulesFor(change: WalChange): Promise<TableRules | Refusal> {
    try {
      const masks = await this.fieldMasks.readMasks(change.schema, change.table)
      const shape = await this.tables.shape(change.schema, change.table)
      return { masks, shape }
    } catch (err) {
      return failed(`table catalog could not be read (SQLSTATE ${sqlState(err)})`)
    }
  }

  /**
   * Row visibility and field verdicts in one transaction, so a subscriber is judged once per
   * change against one snapshot with one set of claims.
   */
  private async judgeAsSubscriber(
    claims: JwtClaims,
    change: WalChange,
    rules: TableRules,
  ): Promise<Verdict> {
    let client: pg.PoolClient
    try {
      client = await this.pool.connect()
    } catch (err) {
      return failed(`no database connection (SQLSTATE ${sqlState(err)})`)
    }
    try {
      await this.beginAs(client, claims)
      const refusal =
        change.event === "DELETE"
          ? await this.deleteRefusal(client, change, rules.shape)
          : await this.recordRefusal(client, change, rules.shape)
      const verdict: Verdict = refusal ?? {
        send: rules.masks.size === 0 ? change : await this.applyMasks(client, change, rules.masks),
      }
      await client.query("COMMIT")
      return verdict
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      // If anything fails (table gone, predicate missing, a value that will not round-trip
      // through jsonb), drop the event. A dropped event is recoverable; a leaked column is
      // not.
      return failed(`visibility check failed (SQLSTATE ${sqlState(err)})`)
    } finally {
      client.release()
    }
  }

  private async beginAs(client: pg.PoolClient, claims: JwtClaims): Promise<void> {
    await client.query("BEGIN")
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await client.query(`SELECT set_config('role', $1, true)`, [claims.role ?? "authenticated"])
  }

  /**
   * Row visibility for INSERT and UPDATE: re-select the row by its primary key under the
   * subscriber's role.
   *
   * Still a re-read rather than a generated `can_read_<table>` call, because the stored
   * policies are authoritative and may include hand-written ones no generated function
   * knows about.
   *
   * The key comes from the catalog, every column of it. It used to be guessed as `id` or else
   * the first column, and on a table keyed by anything else the re-select matched any visible
   * row sharing that first column's value, and the stranger's row went out whole.
   */
  private async recordRefusal(
    client: pg.PoolClient,
    change: WalChange,
    shape: TableShape,
  ): Promise<Refusal | null> {
    const record = change.newRecord ?? change.oldRecord
    if (!record) return failed("change carries no row")
    const key = shape.primaryKey
    if (key.length === 0) return failed("table has no primary key")
    if (key.some((column) => !(column in record))) return failed("change lacks a primary key column")

    const where = key.map((column, i) => `${quoteIdentifier(column)} = $${i + 1}`).join(" AND ")
    const result = await client.query(
      `SELECT 1 FROM ${relationOf(change)} WHERE ${where} LIMIT 1`,
      key.map((column) => record[column]),
    )
    return result.rows.length > 0 ? null : denied("row not visible to subscriber")
  }

  /**
   * DELETE visibility: could the subscriber have seen the row that was deleted?
   *
   * The row is gone, so it cannot be re-selected. It is judged instead by the engine-generated
   * `can_read_<table>(row)` applied to the old tuple from the WAL, as the subscriber. That needs
   * the whole old row, which the WAL carries only under `REPLICA IDENTITY FULL`; with the default
   * identity it carries the key alone, and a key alone cannot be judged. Both that and a table
   * with no generated predicate fail closed.
   *
   * This replaced "does the role hold SELECT on the table", which told every subscriber the key
   * of every deleted row.
   */
  private async deleteRefusal(
    client: pg.PoolClient,
    change: WalChange,
    shape: TableShape,
  ): Promise<Refusal | null> {
    const old = change.oldRecord
    if (!old) return failed("delete carries no old row")
    if (!shape.readPredicate) return failed(`no ${change.table} read predicate (can_read_${change.table})`)
    if (shape.columns.some((column) => !(column in old))) {
      return failed("old row incomplete: the table needs REPLICA IDENTITY FULL")
    }
    const visible = await this.predicateHolds(client, change, shape.readPredicate, old)
    return visible ? null : denied("deleted row was not visible to subscriber")
  }

  private async predicateHolds(
    client: pg.PoolClient,
    change: WalChange,
    predicate: PredicateRef,
    record: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT ${quotePredicateRef(predicate)}(r) AS visible ` +
        `FROM jsonb_populate_record(null::${relationOf(change)}, $1::jsonb) AS r`,
      [JSON.stringify(record)],
    )
    const row = result.rows[0] as { visible?: unknown } | undefined
    return row?.visible === true
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
    const sides = sidesOf(change)
    if (sides.length === 0) return change

    // Columns whose label could not be parsed are masked without asking.
    const askable = columns.filter((column) => masks.get(column) != null)
    const verdicts = askable.length > 0
      ? await this.readVerdicts(client, change, sides, askable, masks)
      : new Map<string, Map<string, boolean | null>>()

    return {
      ...change,
      newRecord: maskRecord(change.newRecord, columns, verdicts.get("new") ?? new Map()),
      oldRecord: maskRecord(change.oldRecord, columns, verdicts.get("old") ?? new Map()),
    }
  }

  /** One query answering every restricted column for every side of the change. */
  private async readVerdicts(
    client: pg.PoolClient,
    change: WalChange,
    sides: Side[],
    askable: string[],
    masks: ReadMasks,
  ): Promise<Map<string, Map<string, boolean | null>>> {
    const from = sides.map(
      (side, index) =>
        `jsonb_populate_record(null::${relationOf(change)}, $${index + 1}::jsonb) AS ${side.alias}`,
    )
    const terms = askable.flatMap((column, columnIndex) => {
      const predicate = quotePredicateRef(masks.get(column) as PredicateRef)
      return sides.map((side) => `${predicate}(${side.alias}) AS ${side.alias}_${columnIndex}`)
    })

    const result = await client.query(
      `SELECT ${terms.join(", ")} FROM ${from.join(", ")}`,
      sides.map((side) => JSON.stringify(side.record)),
    )
    const row = (result.rows[0] ?? {}) as Record<string, unknown>

    const verdicts = new Map<string, Map<string, boolean | null>>()
    for (const side of sides) {
      const perColumn = new Map<string, boolean | null>()
      askable.forEach((column, columnIndex) => {
        perColumn.set(column, row[`${side.alias}_${columnIndex}`] === true ? true : null)
      })
      verdicts.set(side.key, perColumn)
    }
    return verdicts
  }

  async shutdown(): Promise<void> {
    await this.pool.end()
  }
}

interface Side {
  key: "new" | "old"
  alias: string
  record: Record<string, unknown>
}

function sidesOf(change: WalChange): Side[] {
  const sides: Side[] = []
  if (change.newRecord) sides.push({ key: "new", alias: "n", record: change.newRecord })
  if (change.oldRecord) sides.push({ key: "old", alias: "o", record: change.oldRecord })
  return sides
}
