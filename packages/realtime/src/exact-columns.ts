/**
 * Which WAL columns carry a value a double cannot hold.
 *
 * The slot is read with wal2json's `numeric-data-types-as-string`, so every numeric column arrives
 * as a JSON string and nothing is rounded by the parse. That is deliberately indiscriminate: it
 * covers `integer` and `double precision` as well, which do not need it. This module is the other
 * half, deciding from `columntypes` which strings are exact values to keep and which are ordinary
 * numbers to hand back as numbers.
 *
 * Without the option the loss happens inside `JSON.parse` and no later code can undo it. A bigint
 * past 2^53 arrived rounded to its even neighbour, and a `numeric(12,2)` holding 10.00 arrived as
 * 10, so realtime and REST disagreed about the value of the same row. REST keeps both, through
 * `parseRowsExactly` in the client.
 *
 * The kinds match `ExactKind` in `@supatype/client`, because the client coerces what arrives with
 * the same `coerceExactKinds` it already uses for a REST body. They are named rather than imported
 * to avoid a dependency from the server on the browser client for two string literals.
 */

/** A value JavaScript cannot hold exactly: `bigint` becomes a BigInt, `numeric` stays a string. */
export type ExactKind = "bigint" | "numeric"

/** Column name to kind, for the columns of one change that need exact handling. */
export type ExactColumns = Record<string, ExactKind>

/**
 * wal2json reports the declared type, so a width or precision may be attached: `numeric(12,2)`,
 * `character varying(80)`. Only the head matters here.
 */
function baseType(columnType: string): string {
  const head = columnType.split("(")[0] ?? columnType
  return head.trim().toLowerCase()
}

/** Types whose values must survive as text, and what they become on the client. */
const EXACT_TYPES: Record<string, ExactKind> = {
  bigint: "bigint",
  int8: "bigint",
  bigserial: "bigint",
  serial8: "bigint",
  numeric: "numeric",
  decimal: "numeric",
  money: "numeric",
}

/**
 * Numeric types a double holds exactly enough, which are handed back as numbers.
 *
 * `real` and `double precision` are floating point already, so a string round trip returns the
 * same double. The integer types are all well inside the safe range.
 */
const ORDINARY_NUMERIC_TYPES = new Set([
  "smallint",
  "int2",
  "integer",
  "int",
  "int4",
  "serial",
  "serial4",
  "smallserial",
  "real",
  "float4",
  "double precision",
  "float8",
])

/** The exact kind of a wal2json column type, or null when it needs no special handling. */
export function exactKindOf(columnType: string): ExactKind | null {
  return EXACT_TYPES[baseType(columnType)] ?? null
}

/** Whether a column type is a number that should be handed back as a JavaScript number. */
export function isOrdinaryNumeric(columnType: string): boolean {
  return ORDINARY_NUMERIC_TYPES.has(baseType(columnType))
}

/**
 * The value to place in a record, given the column's declared type.
 *
 * Only strings are touched, and only for numeric types. Everything else is passed through, which
 * keeps this safe against a wal2json build that does not honour the option: the values arrive as
 * numbers, the exact ones are already damaged and nothing here can tell, but no working column is
 * broken by the attempt.
 */
export function valueForColumn(value: unknown, columnType: string | undefined): unknown {
  if (typeof value !== "string" || columnType === undefined) return value
  if (exactKindOf(columnType) !== null) return value
  if (!isOrdinaryNumeric(columnType)) return value
  const asNumber = Number(value)
  return Number.isNaN(asNumber) && value.trim() !== "NaN" ? value : asNumber
}

/** The exact columns of one change, for the subscriber to coerce with. */
export function exactColumnsOf(
  names: readonly string[] | undefined,
  types: readonly string[] | undefined,
): ExactColumns {
  const exact: ExactColumns = {}
  if (!names || !types) return exact
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const declared = types[i]
    if (name === undefined || declared === undefined) continue
    const kind = exactKindOf(declared)
    if (kind !== null) exact[name] = kind
  }
  return exact
}
