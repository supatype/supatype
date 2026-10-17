import type { AnyClient, AnyDatabase, SupatypeClient } from "@supatype/client"

/**
 * Where a hook takes its caller at their word.
 *
 * The database, row and response types a caller names (`useSupatype<Db>()`, `useQuery<Db, "posts",
 * Post>`, `useFunction<Order>`) describe what the server sends, and nothing in the browser can check
 * them against it. These are the only places this package turns a value into such a type, each
 * checking what can be checked, so a cast is never scattered through the hooks.
 */

/** The client in context, as the caller's database. Boundary: the database type is the caller's. */
export function isClientFor<TDatabase extends AnyDatabase>(_client: AnyClient): _client is SupatypeClient<TDatabase> {
  return true
}

/** Rows read through the untyped client, as the caller's row type: checked to be a list of objects. */
export function isRowsOf<TRow>(rows: unknown): rows is TRow[] {
  return Array.isArray(rows) && rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))
}

/** A function's answer or a preview's data, as the caller's type. Boundary: any JSON value can be one. */
export function isCallerValue<T>(_value: unknown): _value is T {
  return true
}
