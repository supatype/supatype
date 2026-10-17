/**
 * Rows read from Postgres through `pg`.
 *
 * `pg` types a row as `any` unless the caller names a row type, and naming one is a claim the
 * driver never checks. A row here is an `UnknownRow` instead, and the caller reads each column
 * with its own check (`typeof`, or a guard from `@supatype/shared`).
 */

import { isJsonObject } from "@supatype/shared"

/** One row, keyed by column name, with values not yet checked. */
export type UnknownRow = Record<string, unknown>

/** Anything with `pg`'s `query`: a Pool, a Client, a PoolClient, or a stand-in for one. */
export interface RowQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

/** `rows` as `UnknownRow`s. Throws on a row that is not an object, which object row mode never returns. */
export function toUnknownRows(rows: unknown[]): UnknownRow[] {
  if (!rows.every(isJsonObject)) throw new Error("The query returned rows that are not objects")
  return rows
}

/** The rows `text` returns, for reading column by column. */
export async function queryRows(db: RowQueryable, text: string, values: unknown[] = []): Promise<UnknownRow[]> {
  const { rows } = await db.query(text, values)
  return toUnknownRows(rows)
}
