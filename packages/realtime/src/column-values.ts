/**
 * Columns wal2json writes in Postgres's text form where REST sends JSON.
 *
 * wal2json quotes every column that is not a number or a boolean using the type's text output, so
 * `jsonb` arrives as the JSON text and `timestamptz` as `2024-01-01 12:00:00+00`. REST serialises
 * with `to_json`, which gives the parsed value and `2024-01-01T12:00:00+00:00`. A subscriber sees
 * the REST shape, because Safari and Firefox read the space-separated form as `Invalid Date` and a
 * client that parses the JSON itself has to know which columns to parse.
 *
 * Only the types whose two forms differ are converted. `date`, `time`, text and the rest already
 * match. Arrays of any type are parsed from the Postgres array literal, each element converted as its
 * own type would be. Anything a converter does not recognise is returned as it came: a change must
 * never be lost to a value this code cannot read.
 */

type Convert = (text: string) => unknown

/** The declared type with any width removed and spacing collapsed: `timestamp(3) with time zone`. */
function normalizedType(columnType: string): string {
  return columnType.toLowerCase().replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim()
}

const TIMESTAMP_RE = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/
const TIMESTAMPTZ_RE = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2}){0,2})$/
const TIMETZ_RE = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2}){0,2})$/

/** `+05` as `+05:00` and `-0530` as `-05:30`, the offset form `to_json` writes. */
function fullOffset(offset: string): string {
  const sign = offset.slice(0, 1)
  const digits = offset.slice(1).replace(/:/g, "")
  const parts = [digits.slice(0, 2), digits.slice(2, 4) || "00"]
  if (digits.length > 4) parts.push(digits.slice(4, 6))
  return `${sign}${parts.join(":")}`
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function timestampValue(text: string): unknown {
  const match = TIMESTAMP_RE.exec(text)
  return match === null ? text : `${match[1]}T${match[2]}`
}

function timestamptzValue(text: string): unknown {
  return isoTimestamptz(text)
}

/** A `timestamptz` in Postgres's text form as ISO 8601, or the text as it was when it is not one. */
export function isoTimestamptz(text: string): string {
  const match = TIMESTAMPTZ_RE.exec(text)
  return match === null ? text : `${match[1]}T${match[2]}${fullOffset(match[3] ?? "")}`
}

function timetzValue(text: string): unknown {
  const match = TIMETZ_RE.exec(text)
  return match === null ? text : `${match[1]}${fullOffset(match[2] ?? "")}`
}

function booleanValue(text: string): unknown {
  return text === "t" ? true : text === "f" ? false : text
}

const CONVERTERS: Record<string, Convert> = {
  boolean: booleanValue,
  bool: booleanValue,
  json: jsonValue,
  jsonb: jsonValue,
  timestamp: timestampValue,
  "timestamp without time zone": timestampValue,
  timestamptz: timestamptzValue,
  "timestamp with time zone": timestamptzValue,
  timetz: timetzValue,
  "time with time zone": timetzValue,
}

// ─── Array literals ──────────────────────────────────────────────────────────

/** A parsed array literal: elements are text, null for SQL NULL, or a nested array. */
type ArrayNode = string | null | ArrayNode[]

interface Cursor {
  text: string
  at: number
}

function quotedElement(cursor: Cursor): string | null {
  let out = ""
  cursor.at++
  while (cursor.at < cursor.text.length) {
    const ch = cursor.text.charAt(cursor.at++)
    if (ch === '"') return out
    out += ch === "\\" ? cursor.text.charAt(cursor.at++) : ch
  }
  return null
}

function bareElement(cursor: Cursor): ArrayNode {
  const start = cursor.at
  while (cursor.at < cursor.text.length && !",}".includes(cursor.text.charAt(cursor.at))) cursor.at++
  const raw = cursor.text.slice(start, cursor.at).trim()
  return raw.toUpperCase() === "NULL" ? null : raw
}

function element(cursor: Cursor): ArrayNode | undefined {
  const ch = cursor.text.charAt(cursor.at)
  if (ch === "{") return arrayNode(cursor)
  if (ch === '"') return quotedElement(cursor) ?? undefined
  return bareElement(cursor)
}

/** One `{...}` group, or undefined when the text is not a well-formed literal. */
function arrayNode(cursor: Cursor): ArrayNode[] | undefined {
  cursor.at++
  const items: ArrayNode[] = []
  if (cursor.text.charAt(cursor.at) === "}") {
    cursor.at++
    return items
  }
  for (;;) {
    const item = element(cursor)
    if (item === undefined) return undefined
    items.push(item)
    const next = cursor.text.charAt(cursor.at++)
    if (next === "}") return items
    if (next !== ",") return undefined
  }
}

function parseArrayLiteral(text: string): ArrayNode[] | undefined {
  if (!text.startsWith("{")) return undefined
  const cursor: Cursor = { text, at: 0 }
  const parsed = arrayNode(cursor)
  return cursor.at === text.length ? parsed : undefined
}

function convertNode(node: ArrayNode, convert: Convert): unknown {
  if (node === null) return null
  return typeof node === "string" ? convert(node) : node.map((child) => convertNode(child, convert))
}

function literalElement(item: unknown): string {
  if (item === null) return "NULL"
  if (Array.isArray(item)) return arrayLiteralOf(item)
  const text = typeof item === "object" ? JSON.stringify(item) : String(item)
  return text === "" || /[\s{},"\\]/.test(text) || text.toUpperCase() === "NULL"
    ? `"${text.replace(/["\\]/g, "\\$&")}"`
    : text
}

/**
 * An array as Postgres writes it, `{a,"b c"}`, which is how a filter on an array column is written.
 * Elements converted to another form (timestamps) are written in that form, so a filter on such an
 * array has to be too.
 */
export function arrayLiteralOf(items: readonly unknown[]): string {
  return `{${items.map(literalElement).join(",")}}`
}

/** Converts one element's text, given the element's own declared type. */
export type ElementConverter = (text: string, elementType: string) => unknown

/**
 * The JSON-shaped value of a text column, or `value` itself when its type needs no conversion or
 * the text is not in the form expected. For an array type each element goes through `element`.
 */
export function convertedColumnValue(value: string, columnType: string, element: ElementConverter): unknown {
  const declared = normalizedType(columnType)
  if (!declared.endsWith("[]")) {
    const convert = CONVERTERS[declared]
    return convert === undefined ? value : convert(value)
  }
  const elementType = declared.slice(0, -2)
  const parsed = parseArrayLiteral(value)
  return parsed === undefined ? value : convertNode(parsed, (text) => element(text, elementType))
}
