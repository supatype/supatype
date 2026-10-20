/** A UUID in its canonical 8-4-4-4-12 text form, in either case. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How many of a UUID's last characters a table cell keeps. */
const TAIL_LENGTH = 5

/** Whether `value` is a UUID in its canonical 8-4-4-4-12 text form, in either case. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

/**
 * A UUID as a table cell shows it: its last five characters behind an ellipsis, `…3f9a2`.
 *
 * The tail rather than the head, because a v7 UUID starts with its timestamp, so rows written
 * together share their first characters and differ only at the end.
 */
export function shortUuid(id: string): string {
  return `…${id.slice(-TAIL_LENGTH)}`
}
