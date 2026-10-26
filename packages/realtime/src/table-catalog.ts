import type pg from "pg"
import type { PredicateRef } from "./field-mask.js"
import { TtlCache } from "./ttl-cache.js"
import { rowReadPredicateName } from "./predicate-names.js"

/**
 * What realtime needs to know about a table's shape to judge a change, read from the catalog.
 *
 * Nothing here is guessed from the WAL record. The primary key used to be "`id` if present, else
 * the first column", which on a table keyed by anything else re-selected by a column many rows
 * share and delivered strangers' rows whole.
 */
export interface TableShape {
  /** Every live column, in table order. */
  columns: string[]
  /** The primary key columns, in key order. Empty when the table has none. */
  primaryKey: string[]
  /**
   * The engine-generated row predicate `can_read_<table>(<table>)`, or null when there is none.
   *
   * Looked up in the table's own schema with the table's row type as its only argument, which is
   * exactly the signature the engine emits, so a same-named function elsewhere is never picked up.
   */
  readPredicate: PredicateRef | null
  /**
   * Whether the table's replica identity is FULL (`relreplident = 'f'`), so the WAL carries the
   * whole old row of an UPDATE or DELETE. See `withWholeOldRow` in `rls.ts` for why the record
   * alone cannot tell.
   */
  replicaIdentityFull: boolean
}

/** One row per live column, each also carrying the table's replica identity. */
const COLUMNS_SQL = `
  SELECT a.attname AS name,
         array_position(i.indkey::int2[], a.attnum) AS pk_position,
         c.relreplident = 'f' AS replica_full
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_index i
      ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
   WHERE a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum`

const READ_PREDICATE_SQL = `
  SELECT p.proname AS name
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
           format('%I.%I(%I.%I)', $1::text, $3::text, $1::text, $2::text))
     AND p.prorettype = 'boolean'::regtype`

interface ColumnRow {
  name: string
  pk_position: number | null
  replica_full: boolean
}

/** The key columns in key order, from rows that carry each column's position in the key. */
export function primaryKeyOf(rows: ReadonlyArray<{ name: string; pk_position: number | null }>): string[] {
  return rows
    .filter((row) => row.pk_position !== null)
    .sort((a, b) => (a.pk_position ?? 0) - (b.pk_position ?? 0))
    .map((row) => row.name)
}

/**
 * Table shapes, cached per table.
 *
 * Read on the pool rather than inside a subscriber's transaction, for the same reason as the
 * field rules: the catalog lookup must not run under the subscriber's role.
 */
export class TableCatalog {
  private cache: TtlCache<TableShape>

  constructor(
    private pool: pg.Pool,
    ttlMs = 30_000,
  ) {
    this.cache = new TtlCache(ttlMs)
  }

  invalidate(): void {
    this.cache.clear()
  }

  shape(schema: string, table: string): Promise<TableShape> {
    return this.cache.get(`${schema}.${table}`, () => this.load(schema, table))
  }

  private async load(schema: string, table: string): Promise<TableShape> {
    const [columns, predicate] = await Promise.all([
      this.pool.query<ColumnRow>(COLUMNS_SQL, [schema, table]),
      this.pool.query<{ name: string }>(READ_PREDICATE_SQL, [schema, table, rowReadPredicateName(table)]),
    ])
    const predicateName = predicate.rows[0]?.name
    return {
      columns: columns.rows.map((row) => row.name),
      primaryKey: primaryKeyOf(columns.rows),
      readPredicate: predicateName === undefined ? null : { schema, name: predicateName },
      replicaIdentityFull: columns.rows[0]?.replica_full === true,
    }
  }
}
