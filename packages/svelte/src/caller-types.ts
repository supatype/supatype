/**
 * Where a store takes its caller at their word.
 *
 * The database, row and response types a caller names (`createQuery<Db, "posts", Post>`,
 * `createFunction<Order>`) describe what the server sends,
 * and nothing in the browser can check them against it. These are the only places this package
 * turns a value into such a type, each checking what can be checked, so a cast is never scattered
 * through the stores.
 */

/** Rows read through the untyped client, as the caller's row type: checked to be a list of objects. */
export function isRowsOf<TRow>(rows: unknown): rows is TRow[] {
  return Array.isArray(rows) && rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))
}

/** A function's answer, as the caller's type. Boundary: any JSON value can be one. */
export function isCallerValue<T>(_value: unknown): _value is T {
  return true
}
