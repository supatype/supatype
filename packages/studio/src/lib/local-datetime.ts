/**
 * A date-time field's round trip through `<input type="datetime-local">`, which holds a wall time
 * with no zone.
 *
 * It showed the stored value's own digits (UTC, for a `timestamptz`) and saved what was typed as
 * the browser's local time, so every edit in a zone other than UTC moved the value by the offset.
 * Now the field is in the editor's local time both ways, and what is saved names its offset:
 *
 * - A value that carries a zone (`timestamptz`, which PostgREST returns with one) is an instant, and
 *   is shown at the editor's local wall time.
 * - A value with no zone (`timestamp` without time zone) is a wall time, and is shown as stored.
 * - What is saved is the typed wall time with the editor's offset, `2026-10-15T14:00:00+01:00`. A
 *   `timestamptz` column reads that as the instant meant; a `timestamp` column ignores the offset
 *   and keeps the wall time as typed. One form is right for both, so the widget does not need to
 *   know which it is editing, which the admin config does not say.
 */

const pad = (n: number): string => String(n).padStart(2, "0")

/** A time with a zone: `Z`, `+01`, `+0100` or `+01:00` after the time of day. */
const ZONED = /[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i

/** `date`'s local wall time, as a datetime-local input holds it. */
function localWallTime(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The input's value for a stored date-time, or "" for none. */
export function toLocalInput(value: unknown): string {
  if (value === null || value === undefined || value === "") return ""
  const text = String(value).trim()
  if (!ZONED.test(text)) return text.replace(" ", "T").slice(0, 16)
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text.slice(0, 16) : localWallTime(date)
}

/** The editor's UTC offset at `date`, as `+01:00`. */
function offsetAt(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** What to save for an input's value: its wall time with the editor's offset, or null for none. */
export function fromLocalInput(input: string): string | null {
  if (input === "") return null
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  const seconds = input.length === 16 ? `${input}:00` : input
  return `${seconds}${offsetAt(date)}`
}

/** `date` as a value to save: its local wall time with the offset. */
export function localTimestamp(date: Date): string {
  return `${localWallTime(date)}:${pad(date.getSeconds())}${offsetAt(date)}`
}

/** The editor's time zone, for saying which zone the field is in. */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
