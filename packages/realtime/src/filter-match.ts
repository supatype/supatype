import type { WalChange } from "./types.js"

/**
 * Matching a subscriber's PostgREST-style column filter (`salary=gt.100000`) against a change.
 *
 * Values are compared by the column's declared type, the way Postgres would compare them. They
 * used to be compared as strings, so `salary=gt.100000` delivered a salary of 95000 because
 * "95000" sorts after "100000".
 *
 * A NULL or absent value matches nothing, as in SQL, and so does a value that cannot be read as
 * the column's type. A filter that cannot be evaluated is not a reason to deliver.
 */

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte"

interface Condition {
  op: FilterOp
  value: string
}

/** How values of a column are ordered. Anything not recognised is compared as text. */
export type CompareKind = "number" | "decimal" | "boolean" | "timestamp" | "timestamptz" | "date" | "time" | "uuid" | "text"

const KIND_BY_TYPE: Record<string, CompareKind> = {
  smallint: "number", int2: "number", integer: "number", int: "number", int4: "number",
  serial: "number", serial4: "number", smallserial: "number",
  real: "number", float4: "number", "double precision": "number", float8: "number",
  bigint: "decimal", int8: "decimal", bigserial: "decimal", serial8: "decimal",
  numeric: "decimal", decimal: "decimal", money: "decimal",
  boolean: "boolean", bool: "boolean",
  timestamp: "timestamp", "timestamp without time zone": "timestamp",
  timestamptz: "timestamptz", "timestamp with time zone": "timestamptz",
  date: "date",
  time: "time", "time without time zone": "time", timetz: "time", "time with time zone": "time",
  uuid: "uuid",
}

/** The comparison a declared type calls for. Width and precision (`numeric(12,2)`) are ignored. */
export function compareKindOf(columnType: string | undefined): CompareKind {
  if (columnType === undefined) return "text"
  const declared = columnType.trim().toLowerCase()
  if (declared.endsWith("[]")) return "text"
  const head = declared.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim()
  return KIND_BY_TYPE[head] ?? "text"
}

function parseCondition(condition: string): Condition | null {
  const match = /^(eq|neq|gt|gte|lt|lte)\.(.+)$/s.exec(condition)
  if (!match) return null
  return { op: match[1] as FilterOp, value: match[2]! }
}

// ─── Per-kind ordering ───────────────────────────────────────────────────────

type Order = -1 | 0 | 1

const sign = (n: number): Order => (n < 0 ? -1 : n > 0 ? 1 : 0)
const orderOf = <T>(a: T, b: T): Order => (a < b ? -1 : a > b ? 1 : 0)

function compareNumbers(actual: unknown, expected: string): Order | null {
  const a = typeof actual === "number" ? actual : Number(String(actual).trim())
  const b = Number(expected.trim())
  if (expected.trim() === "" || Number.isNaN(a) || Number.isNaN(b)) return null
  return orderOf(a, b)
}

interface Decimal {
  negative: boolean
  whole: string
  fraction: string
}

/** A decimal string as sign, integer digits and fraction digits, with no redundant zeros. */
export function parseDecimal(raw: string): Decimal | null {
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(raw.trim().replace(/[$,\s]/g, ""))
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null
  const whole = match[2]!.replace(/^0+/, "")
  const fraction = (match[3] ?? "").replace(/0+$/, "")
  const zero = whole === "" && fraction === ""
  return { negative: match[1] === "-" && !zero, whole, fraction }
}

function compareMagnitudes(a: Decimal, b: Decimal): Order {
  if (a.whole.length !== b.whole.length) return sign(a.whole.length - b.whole.length)
  if (a.whole !== b.whole) return orderOf(a.whole, b.whole)
  const width = Math.max(a.fraction.length, b.fraction.length)
  return orderOf(a.fraction.padEnd(width, "0"), b.fraction.padEnd(width, "0"))
}

/** Exact comparison for bigint and numeric, which arrive as strings a double cannot hold. */
export function compareDecimals(actual: unknown, expected: string): Order | null {
  const a = parseDecimal(String(actual))
  const b = parseDecimal(expected)
  if (!a || !b) return null
  if (a.negative !== b.negative) return a.negative ? -1 : 1
  const magnitude = compareMagnitudes(a, b)
  return a.negative ? (-magnitude as Order) : magnitude
}

const TRUE_WORDS = new Set(["true", "t", "yes", "y", "on", "1"])
const FALSE_WORDS = new Set(["false", "f", "no", "n", "off", "0"])

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  const word = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return null
}

function compareBooleans(actual: unknown, expected: string): Order | null {
  const a = toBoolean(actual)
  const b = toBoolean(expected)
  if (a === null || b === null) return null
  return orderOf(Number(a), Number(b))
}

// ─── Dates and times, as microseconds ────────────────────────────────────────

const CLOCK = String.raw`(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?`
const ZONE = String.raw`\s*(Z|[+-]\d{2}(?::?\d{2})?)?`
const DATETIME_RE = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})(?:[T ]${CLOCK})?${ZONE}$`, "i")
const TIME_RE = new RegExp(String.raw`^${CLOCK}${ZONE}$`, "i")
const INFINITY = 2n ** 62n

/** Offset east of UTC in minutes, from `Z`, `+05`, `+0530` or `-05:30`. */
function zoneMinutes(zone: string | undefined): number {
  if (!zone || zone.toUpperCase() === "Z") return 0
  const digits = zone.slice(1).replace(":", "")
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0")
  return zone.startsWith("-") ? -minutes : minutes
}

function clockMicros(h?: string, m?: string, s?: string, frac?: string): bigint {
  const seconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
  return BigInt(seconds) * 1_000_000n + BigInt((frac ?? "").slice(0, 6).padEnd(6, "0"))
}

/**
 * A date, timestamp or time as microseconds, so sub-millisecond values still order correctly.
 *
 * The zone is applied only where the type has one: Postgres reads `timestamp` input with an
 * offset by discarding the offset, and so does this.
 */
export function temporalMicros(raw: string, kind: CompareKind): bigint | null {
  const text = raw.trim().toLowerCase()
  if (text === "infinity") return INFINITY
  if (text === "-infinity") return -INFINITY
  const zoned = kind === "timestamptz"
  if (kind === "time") {
    const t = TIME_RE.exec(text)
    return t ? clockMicros(t[1], t[2], t[3], t[4]) : null
  }
  const d = DATETIME_RE.exec(text)
  if (!d) return null
  const day = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))
  if (Number.isNaN(day)) return null
  const offset = zoned ? BigInt(zoneMinutes(d[8])) * 60_000_000n : 0n
  return BigInt(day) * 1000n + clockMicros(d[4], d[5], d[6], d[7]) - offset
}

function compareTemporal(actual: unknown, expected: string, kind: CompareKind): Order | null {
  const a = temporalMicros(String(actual), kind)
  const b = temporalMicros(expected, kind)
  if (a === null || b === null) return null
  return orderOf(a, b)
}

/** -1, 0 or 1 for actual against expected, or null when they cannot be compared as this kind. */
export function compareAs(kind: CompareKind, actual: unknown, expected: string): Order | null {
  switch (kind) {
    case "number": return compareNumbers(actual, expected)
    case "decimal": return compareDecimals(actual, expected)
    case "boolean": return compareBooleans(actual, expected)
    case "timestamp":
    case "timestamptz":
    case "date":
    case "time": return compareTemporal(actual, expected, kind)
    case "uuid": return orderOf(String(actual).toLowerCase(), expected.toLowerCase())
    case "text": return orderOf(String(actual), expected)
  }
}

const ACCEPTS: Record<FilterOp, (order: Order) => boolean> = {
  eq: (o) => o === 0,
  neq: (o) => o !== 0,
  gt: (o) => o > 0,
  gte: (o) => o >= 0,
  lt: (o) => o < 0,
  lte: (o) => o <= 0,
}

function satisfies(actual: unknown, condition: Condition, columnType: string | undefined): boolean {
  if (actual === null || actual === undefined) return false
  const order = compareAs(compareKindOf(columnType), actual, condition.value)
  return order !== null && ACCEPTS[condition.op](order)
}

/**
 * Whether a change passes every condition of a subscriber's filter.
 *
 * A condition in a form the grammar does not know is ignored, as before: it can only widen what
 * the subscriber asked for, and every delivery is still judged for visibility.
 */
export function matchesFilter(change: WalChange, filter: Record<string, string>): boolean {
  const record = change.newRecord ?? change.oldRecord
  if (!record) return true
  for (const [column, raw] of Object.entries(filter)) {
    const condition = parseCondition(raw)
    if (!condition) continue
    if (!satisfies(record[column], condition, change.columnTypes[column])) return false
  }
  return true
}
