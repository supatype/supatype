import type { ModelConfig } from "../config.js"

/** One column of a list's order. */
export interface ListOrder {
  column: string
  ascending: boolean
}

/** The part of a query builder this module needs, so it applies to any table's query. */
interface Orderable<Q> {
  order(column: string, opts: { ascending: boolean }): Q
}

/**
 * The full order a list asks the server for.
 *
 * What the user chose wins; otherwise the model's default, otherwise nothing. Every key column the
 * order does not already name is then appended, in the direction of the last column, so the order
 * ends on something unique. Without that, two rows with the same sort value come back in whatever
 * order Postgres finds them, which can differ between two page requests and repeat or skip a row.
 */
export function listOrder(
  chosen: readonly ListOrder[],
  fallback: ListOrder | undefined,
  keyColumns: readonly string[],
): ListOrder[] {
  const base = chosen.length > 0 ? [...chosen] : fallback === undefined ? [] : [fallback]
  const ascending = base.at(-1)?.ascending ?? true
  const named = new Set(base.map((o) => o.column))
  const ties = keyColumns.filter((column) => !named.has(column)).map((column) => ({ column, ascending }))
  return [...base, ...ties]
}

/**
 * A model's key columns. Engines before `primaryKey` was sent name none, and every model they
 * describe is keyed on `id`, which is what Studio assumed for them.
 */
export function modelKeyColumns(model: Pick<ModelConfig, "primaryKey" | "primaryKeyColumns">): string[] {
  return model.primaryKeyColumns ?? [model.primaryKey]
}

/**
 * A table's key columns from the database's own metadata, or `ctid` for a table with none.
 *
 * `ctid` is a row's physical position: unique at any one moment, so a page is never repeated or
 * skipped while nothing writes, but it moves when a row is updated. It is the last resort for a
 * table that gives nothing better, which is also where Supabase's table editor ends up.
 */
export function tableKeyColumns(columns: ReadonlyArray<{ name: string; is_primary: boolean }>): string[] {
  const keys = columns.filter((c) => c.is_primary).map((c) => c.name)
  return keys.length > 0 ? keys : ["ctid"]
}

/** `query` ordered by every column of `order`, first to last. */
export function withOrder<Q extends Orderable<Q>>(query: Q, order: readonly ListOrder[]): Q {
  return order.reduce((q, o) => q.order(o.column, { ascending: o.ascending }), query)
}
