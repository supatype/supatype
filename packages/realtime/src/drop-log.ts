import type { ChangeEvent } from "./types.js"
import type { LogLevel } from "./env.js"

/**
 * One line per change a subscriber did not receive, and why: always when realtime could not decide,
 * and at `REALTIME_LOG_LEVEL=debug` also when the access rules withheld it.
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

/**
 * A failure is logged at warn whatever the level. A denial only at `debug`: it is the normal case,
 * one line per event per subscriber who may not see it, and at the default level it would bury the
 * failures among lines that need no action.
 */
export function logDrop(drop: DroppedChange, severity: DropSeverity, level: LogLevel): void {
  if (severity === "failed") console.warn(formatDrop(drop))
  else if (level === "debug") console.debug(formatDrop(drop))
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
