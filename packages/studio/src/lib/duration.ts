/**
 * A `Duration` field: stored as JSONB `{ ms }`, edited and shown as text such as `1h 30m`.
 *
 * One parser and one formatter, shared by the edit widget, the list cell and the save check, so a
 * value reads the same everywhere it appears.
 *
 * Decisions, recorded here because they are visible to editors:
 * - **Days are allowed.** `1d` is exactly 24 hours (no working-day reading, unlike Jira's 8h day),
 *   and the formatter shows days once a value reaches 24 hours: 30 hours reads `1d 6h`.
 * - **Milliseconds show only when there are some.** `1m 30s 250ms`; a whole number of seconds never
 *   carries a `0ms`. Input may give them as `250ms`, as a decimal (`1.5s`) or after a colon
 *   (`1:02:03.5`), and anything finer than a millisecond rounds to the nearest one.
 * - **A bare number is refused.** `90` could be seconds or minutes, so the editor is asked to add a
 *   unit rather than have Studio guess.
 * - **Two colon parts are hours and minutes** (`1:30` is 1h 30m), as Airtable's `h:mm` reads them.
 *   Minutes and seconds after a colon are two digits under 60; the hours before it are not capped.
 */

import { isJsonObject } from "./json.js"

export type ParsedDuration = { ok: true; ms: number | null } | { ok: false; message: string }

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

interface Unit {
  symbol: string
  ms: number
  words: readonly string[]
}

/** Each unit the formatter writes, largest first, with the words the parser also takes for it. */
const UNITS: readonly Unit[] = [
  { symbol: "d", ms: DAY, words: ["d", "day", "days"] },
  { symbol: "h", ms: HOUR, words: ["h", "hr", "hrs", "hour", "hours"] },
  { symbol: "m", ms: MINUTE, words: ["m", "min", "mins", "minute", "minutes"] },
  { symbol: "s", ms: SECOND, words: ["s", "sec", "secs", "second", "seconds"] },
  { symbol: "ms", ms: 1, words: ["ms", "msec", "millisecond", "milliseconds"] },
]

const HINT = "Try 1h 30m, 90m or 1:30:00."
const COLON_FORM = /^(\d+):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/
/** One `<number><unit>` term, with what may separate it from the next. */
const TERM = /^(\d+(?:\.\d+)?)\s*([a-z]+)[\s,]*/
const BARE_NUMBER = /^\d+(?:\.\d+)?$/

function refuse(message: string): ParsedDuration {
  return { ok: false, message }
}

function unreadable(text: string): ParsedDuration {
  return refuse(`Could not read "${text}" as a duration. ${HINT}`)
}

function unitFor(word: string): Unit | undefined {
  return UNITS.find((unit) => unit.words.includes(word))
}

/** A total in milliseconds, refused when it is too large to hold exactly. */
function total(ms: number): ParsedDuration {
  const rounded = Math.round(ms)
  return Number.isSafeInteger(rounded) ? { ok: true, ms: rounded } : refuse("That duration is too long to store.")
}

/** `h:mm` or `h:mm:ss`, with an optional fraction of a second. */
function parseColonForm(text: string): ParsedDuration {
  const match = COLON_FORM.exec(text)
  if (match === null) return unreadable(text)
  const [, hours = "0", minutes = "0", seconds = "0", fraction = ""] = match
  if (Number(minutes) >= 60 || Number(seconds) >= 60) {
    return refuse("Minutes and seconds after a colon must be under 60.")
  }
  const secondsMs = Number(`${seconds}${fraction}`) * SECOND
  return total(Number(hours) * HOUR + Number(minutes) * MINUTE + secondsMs)
}

/** `1h 30m`, `90 minutes`, `1.5h`: each unit at most once, in any order. */
function parseUnitForm(text: string): ParsedDuration {
  const seen = new Set<string>()
  let rest = text
  let ms = 0
  while (rest.length > 0) {
    const match = TERM.exec(rest)
    if (match === null) return unreadable(text)
    const [whole, amount = "", word = ""] = match
    const unit = unitFor(word)
    if (unit === undefined) return refuse(`"${word}" is not a unit Studio knows. Use d, h, m, s or ms.`)
    if (seen.has(unit.symbol)) return refuse(`"${unit.symbol}" is given more than once.`)
    seen.add(unit.symbol)
    ms += Number(amount) * unit.ms
    rest = rest.slice(whole.length)
  }
  return total(ms)
}

/** Text an editor typed, as milliseconds; blank text is no value rather than an error. */
export function parseDuration(input: string): ParsedDuration {
  const text = input.trim().toLowerCase()
  if (text === "") return { ok: true, ms: null }
  if (text.startsWith("-")) return refuse("A duration cannot be negative.")
  if (BARE_NUMBER.test(text)) return refuse(`Add a unit to ${text}, for example ${text}m.`)
  return text.includes(":") ? parseColonForm(text) : parseUnitForm(text)
}

/** Milliseconds as `1d 2h 3m 4s 5ms`, leaving out every unit that is zero; zero itself is `0s`. */
export function formatDuration(ms: number): string {
  let rest = Math.round(ms)
  const parts: string[] = []
  for (const unit of UNITS) {
    const count = Math.floor(rest / unit.ms)
    rest -= count * unit.ms
    if (count > 0) parts.push(`${count}${unit.symbol}`)
  }
  return parts.length > 0 ? parts.join(" ") : "0s"
}

/** The milliseconds a stored `{ ms }` holds, or null for anything that is not one. */
export function durationMsOf(value: unknown): number | null {
  if (!isJsonObject(value)) return null
  const ms = value["ms"]
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** A stored duration as text, for a list cell or a read-only display; null when it is not one. */
export function formatDurationValue(value: unknown): string | null {
  const ms = durationMsOf(value)
  return ms === null ? null : formatDuration(ms)
}
