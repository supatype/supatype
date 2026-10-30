/**
 * Rows read from Postgres through `pg`.
 *
 * `pg` types a row as `any` unless the caller names a row type, and naming one is a claim the
 * driver never checks. A row here is an `UnknownRow` instead, and the caller reads each column
 * with its own check (`typeof`, or a guard from `@supatype/shared`).
 */

import { isJsonObject } from "@supatype/shared"
import { errorMessage } from "./error-message.js"
import type { Client } from "pg"

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

/** A database the CLI could not connect to, apart from a failure once connected. */
export class DatabaseConnectFailed extends Error {
  override readonly name = "DatabaseConnectFailed"
}

/**
 * Connect to `url`, run `use` with the client, and end the connection whatever happens. `pg` is
 * loaded here, on first use, as each caller loaded it before. A failure to connect throws
 * {@link DatabaseConnectFailed}, so a caller can say so in its own words.
 */
export async function withDatabase<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg")
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
  } catch (err) {
    await client.end().catch(() => undefined)
    throw new DatabaseConnectFailed(errorMessage(err), { cause: err })
  }
  try {
    return await use(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}
