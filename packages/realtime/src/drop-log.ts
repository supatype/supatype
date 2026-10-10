import type { ChangeEvent } from "./types.js"

/**
 * One line per change a subscriber did not receive, and why.
 *
 * Realtime used to drop events silently, so "my subscriber hears nothing" could not be told apart
 * from "nothing happened". The line names the table, the operation, the subscriber's role and the
 * reason, and never a value from the row: the reason a row was withheld must not become a way to
 * read it from the logs.
 */
export interface DroppedChange {
  schema: string
  table: string
  event: ChangeEvent
  role: string
  reason: string
}

/**
 * `denied` is the rules working as written (the subscriber may not see the row). `failed` is
 * realtime unable to decide, which fails closed and is worth an operator's attention.
 */
export type DropSeverity = "denied" | "failed"

export function formatDrop(drop: DroppedChange): string {
  return (
    `[realtime] dropped ${drop.event} on ${drop.schema}.${drop.table} ` +
    `for role ${drop.role}: ${drop.reason}`
  )
}

export function logDrop(drop: DroppedChange, severity: DropSeverity): void {
  if (severity === "failed") console.warn(formatDrop(drop))
  else console.log(formatDrop(drop))
}

/**
 * The SQLSTATE of a database error, and only that.
 *
 * A Postgres error message can quote the offending value (`invalid input syntax for type
 * integer: "..."`), which here would be a value from the row. The code says what went wrong
 * without it.
 */
export function sqlState(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return "unknown"
}
