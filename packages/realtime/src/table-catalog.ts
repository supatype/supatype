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
   * Looked up in the table's own schema, taking the table's row type first and nothing else that
   * lacks a default, so a same-named function elsewhere, or one a call with the row alone cannot
   * reach, is never picked up. From 0.7 the engine adds a defaulted parameter that keeps the
   * predicate out of GraphQL (CT3); an older engine's took the row alone. A call with the row
   * alone fits both.
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
    JOIN pg_class c ON c.oid = to_regclass(format('%I.%I', $1::text, $2::text))
   WHERE p.pronamespace = c.relnamespace
     AND p.proname = $3
     AND p.proargtypes[0] = c.reltype
     AND p.pronargs - p.pronargdefaults = 1
     AND p.prorettype = 'boolean'::regtype`

/** The relation's kind (`r` table, `p` partitioned table, `v` view, ...), when there is one. */
const RELATION_KIND_SQL = `
  SELECT c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2`

/** Relation kinds whose rows reach the WAL as changes: a table, and a partitioned one. */
const TABLE_KINDS = new Set(["r", "p"])

/**
 * Why a join for `schema.table` is refused given the relation's kind, or null when it is a table.
 *
 * 0.9.2 release test (N-FF5): a join for a table that does not exist was acknowledged, and the
 * client reported SUBSCRIBED for a subscription nothing could ever match.
 */
export function relationRefusal(schema: string, table: string, kind: string | null): string | null {
  const name = `${schema}.${table}`
  if (kind === null) return `table ${name} does not exist: check the table name and schema`
  if (!TABLE_KINDS.has(kind)) return `${name} is not a table: changes are published for tables only`
  return null
}

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
  private kinds: TtlCache<string | null>

  constructor(
    private pool: pg.Pool,
    ttlMs = 30_000,
  ) {
    this.cache = new TtlCache(ttlMs)
    this.kinds = new TtlCache(ttlMs)
  }

  invalidate(): void {
    this.cache.clear()
    this.kinds.clear()
  }

  shape(schema: string, table: string): Promise<TableShape> {
    return this.cache.get(`${schema}.${table}`, () => this.load(schema, table))
  }

  /**
   * The relation's kind, or null when `schema.table` does not exist.
   *
   * Asked on every join, so a kind is cached like a shape. A missing table is not: the next
   * migration may create it, and a misspelt name costs one catalog query per join.
   */
  async relationKind(schema: string, table: string): Promise<string | null> {
    const key = `${schema}.${table}`
    const kind = await this.kinds.get(key, async () => {
      const result = await this.pool.query<{ kind: string }>(RELATION_KIND_SQL, [schema, table])
      return result.rows[0]?.kind ?? null
    })
    if (kind === null) this.kinds.forget(key)
    return kind
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
