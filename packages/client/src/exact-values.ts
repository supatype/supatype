/**
 * Keeping exact-value columns intact across `JSON.parse`.
 *
 * `bigInt`, `decimal` and `money` name values no binary float holds. Postgres stores them exactly
 * and PostgREST writes the correct digits on the wire, as unquoted JSON numbers. `JSON.parse` then
 * reads each one into an IEEE-754 double, and 9007199254740993 comes back as 9007199254740992.
 *
 * Nothing after the parse can recover the digits, so the repair has to happen on the response text
 * while they are still there: quote the value, let `JSON.parse` produce a string, and convert from
 * that. This also makes runtime agree with the generated types, which declare `bigint` for BIGINT
 * and `string` for the two NUMERIC kinds, matching `@supatype/types`.
 *
 * Deliberately not implemented with `JSON.parse`'s source-accessing reviver: that is recent enough
 * that a runtime without it would silently fall back to corruption, which is the failure this
 * module exists to remove.
 */

/** The two shapes a column can need. `numeric` covers both `decimal` and `money`. */
export type ExactKind = "bigint" | "numeric"

/** Column name to kind, for the table being read. */
export type ExactFields = Readonly<Record<string, ExactKind>>

const WHITESPACE = new Set([" ", "\t", "\n", "\r"])
const QUOTE = '"'

/** A numeric literal found as the value of a key, with where it sits in the text. */
type KeyedNumber = {
  readonly key: string
  readonly depth: number
  readonly start: number
  readonly end: number
}

/**
 * Walk the JSON text and report every numeric literal that is the value of a key.
 *
 * One scanner rather than one per caller, because the hard part is shared: tracking string state
 * so a key name written inside a string value is not mistaken for a column.
 */
function forEachKeyedNumber(body: string, visit: (found: KeyedNumber) => void): void {
  let i = 0
  let depth = 0
  let pendingKey: string | null = null

  while (i < body.length) {
    const ch = body[i] as string

    if (ch === QUOTE) {
      const end = endOfString(body, i)
      const raw = body.slice(i, end)
      i = end
      pendingKey = nextMeaningfulChar(body, i) === ":" ? readKey(raw) : null
      continue
    }

    if (ch === "{" || ch === "[") {
      depth += 1
      i += 1
      continue
    }

    if (ch === "}" || ch === "]") {
      depth -= 1
      i += 1
      continue
    }

    if (ch === ":") {
      i += 1
      while (i < body.length && WHITESPACE.has(body[i] as string)) i += 1
      const key = pendingKey
      pendingKey = null
      if (key !== null) {
        const end = endOfNumber(body, i)
        if (end > i) {
          visit({ key, depth, start: i, end })
          i = end
        }
      }
      continue
    }

    i += 1
  }
}

/**
 * Quote the numeric literals belonging to exact-value columns, so the digits survive the parse.
 *
 * Returns `body` unchanged when there is nothing to do, so the common request pays a scan and no
 * string building.
 */
export function quoteExactNumbers(body: string, fields: ExactFields): string {
  if (Object.keys(fields).length === 0) return body

  // A list response nests rows one level deeper than a single-object response. Columns are only
  // rewritten at row level: an embedded resource can carry a same-named column of another kind,
  // and the select that produced it is not parsed here, so rewriting it would be a guess.
  const rowDepth = firstMeaningfulChar(body) === "[" ? 2 : 1

  const spans: KeyedNumber[] = []
  forEachKeyedNumber(body, (found) => {
    if (found.depth === rowDepth && fields[found.key] !== undefined) spans.push(found)
  })
  if (spans.length === 0) return body

  let out = ""
  let cursor = 0
  for (const span of spans) {
    // The literal, verbatim. Trailing zeros and exponents are part of what was sent.
    const literal = body.slice(span.start, span.end)
    out += body.slice(cursor, span.start)
    out += JSON.stringify(literal)
    cursor = span.end
  }
  return out + body.slice(cursor)
}

/**
 * The columns whose literals will not survive `JSON.parse`.
 *
 * The safety net for when column metadata could not be loaded. Without it a failed metadata fetch
 * would quietly restore the corruption this module exists to remove. Reports at any depth, since
 * over-reporting here costs a clear error and under-reporting costs a wrong number.
 */
export function findLossyNumbers(body: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  forEachKeyedNumber(body, (found) => {
    if (seen.has(found.key)) return
    if (!isLossy(body.slice(found.start, found.end))) return
    seen.add(found.key)
    names.push(found.key)
  })
  return names
}

/**
 * Convert the quoted values to the types the generated `database.ts` declares.
 *
 * `bigint` columns become native bigints. `numeric` columns stay exact strings, because JavaScript
 * has no native exact decimal, which is why `@supatype/types` declares Decimal and Money `string`.
 */
export function coerceExactKinds(value: unknown, fields: ExactFields): unknown {
  if (Object.keys(fields).length === 0) return value
  if (Array.isArray(value)) return value.map((row) => coerceRow(row, fields))
  return coerceRow(value, fields)
}

/**
 * `JSON.stringify` that does not throw on a bigint.
 *
 * Reading a row and writing it back would otherwise fail the moment the generated types started
 * declaring `bigint`, because `JSON.stringify` refuses to serialise one.
 */
export function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  )
}

function coerceRow(row: unknown, fields: ExactFields): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row

  const source = row as Record<string, unknown>
  let copy: Record<string, unknown> | null = null

  for (const [name, kind] of Object.entries(fields)) {
    if (kind !== "bigint") continue
    const current = source[name]
    if (typeof current !== "string") continue
    copy ??= { ...source }
    copy[name] = BigInt(current)
  }

  return copy ?? row
}

/** Whether parsing this literal as a double changes the value it names. */
function isLossy(literal: string): boolean {
  const asNumber = Number(literal)
  if (!Number.isFinite(asNumber)) return true
  // Compared as values rather than as text, so `19.0000` arriving as `19` is not called a loss.
  // It is a type-fidelity problem, and throwing on it would break every project with a money
  // column whose metadata failed to load.
  return normalizeDecimal(literal) !== normalizeDecimal(String(asNumber))
}

/** A literal rewritten as a plain decimal with no exponent and no insignificant zeros. */
function normalizeDecimal(literal: string): string {
  const parts = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal)
  if (parts === null) return literal

  const sign = parts[1] ?? ""
  const exponent = parts[4] !== undefined ? Number(parts[4]) : 0
  const integerPart = parts[2] ?? ""
  const fractionPart = parts[3] ?? ""

  let digits = integerPart + fractionPart
  let pointAt = integerPart.length + exponent

  if (pointAt <= 0) {
    digits = "0".repeat(1 - pointAt) + digits
    pointAt = 1
  }
  if (pointAt >= digits.length) {
    digits += "0".repeat(pointAt - digits.length)
  }

  const head = digits.slice(0, pointAt).replace(/^0+(?=\d)/, "")
  const tail = digits.slice(pointAt).replace(/0+$/, "")
  const magnitude = tail === "" ? head : head + "." + tail

  return /^0(\.0*)?$/.test(magnitude) ? "0" : sign + magnitude
}

function firstMeaningfulChar(body: string): string | undefined {
  return nextMeaningfulChar(body, 0)
}

function nextMeaningfulChar(body: string, from: number): string | undefined {
  for (let i = from; i < body.length; i += 1) {
    const ch = body[i] as string
    if (!WHITESPACE.has(ch)) return ch
  }
  return undefined
}

/** Index just past the closing quote of the string starting at `start`. */
function endOfString(body: string, start: number): number {
  let i = start + 1
  while (i < body.length) {
    const ch = body[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === QUOTE) return i + 1
    i += 1
  }
  return i
}

/** The key a raw JSON string token names, with escapes resolved. */
function readKey(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "string" ? parsed : null
  } catch {
    return null
  }
}

/** Index just past the JSON number starting at `from`, or `from` when one does not start there. */
function endOfNumber(body: string, from: number): number {
  let i = from
  if (body[i] === "-") i += 1
  const digitsStart = i
  while (i < body.length && isDigit(body[i] as string)) i += 1
  if (i === digitsStart) return from

  if (body[i] === ".") {
    i += 1
    while (i < body.length && isDigit(body[i] as string)) i += 1
  }

  if (body[i] === "e" || body[i] === "E") {
    let j = i + 1
    if (body[j] === "+" || body[j] === "-") j += 1
    const expStart = j
    while (j < body.length && isDigit(body[j] as string)) j += 1
    if (j > expStart) i = j
  }

  return i
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}
