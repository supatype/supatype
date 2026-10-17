import { isJsonObject, isString, safeParseJson } from "./json.js"

/**
 * What one push did, as the engine recorded it in `_supatype.migrations`: applied, failed while it
 * applied (nothing of it kept), refused before it began (nothing applied), or applied and later
 * rolled back. An engine from before the `status` column wrote only applied rows, and the
 * catalogue reads its history as applied.
 */
export type MigrationStatus = "applied" | "failed" | "refused" | "rolled_back"

export const MIGRATION_STATUSES: readonly MigrationStatus[] = ["applied", "failed", "refused", "rolled_back"]

/** The badge colour of each status. */
export const MIGRATION_STATUS_VARIANT: Record<MigrationStatus, "green" | "red" | "yellow"> = {
  applied: "green",
  failed: "red",
  refused: "red",
  rolled_back: "yellow",
}

/** "rolled back" for `rolled_back`, the status itself otherwise. */
export function migrationStatusLabel(status: MigrationStatus): string {
  return status.replace("_", " ")
}

/** Why a refused push was refused, as the engine recorded it in `refusal`. */
export interface PushRefusal {
  /** `destructive`, `rewrite`, `security_drift` or `conflicts`. */
  reason: string | null
  /** The statements it would have run. */
  sql: string | null
  /** What it would have dropped or rewritten, or the objects in its way, one line each. */
  operations: string[]
  /** The commands that apply it, or deal with what refused it. */
  hints: string[]
}

/** A migration's outcome: its status, why when it did not apply, and whether a push applied since. */
export interface MigrationOutcome {
  status: MigrationStatus
  error: string | null
  refusal: PushRefusal | null
  /** A later push applied, so this refusal or failure no longer describes the project. */
  superseded: boolean
}

/** A JSON column, which a proxy hands over parsed or as its text. */
function jsonColumn(value: unknown): unknown {
  return typeof value === "string" ? safeParseJson(value) : value
}

/** A list of strings from a JSON column, or none. */
export function stringList(value: unknown): string[] {
  const parsed = jsonColumn(value)
  return Array.isArray(parsed) ? parsed.filter(isString) : []
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function isTrue(value: unknown): boolean {
  return value === true || value === "t" || value === "true"
}

/** The `refusal` column, or null for a row that was not refused. */
export function readRefusal(value: unknown): PushRefusal | null {
  const parsed = jsonColumn(value)
  if (!isJsonObject(parsed)) return null
  return {
    reason: text(parsed["reason"]),
    sql: text(parsed["sql"]),
    operations: stringList(parsed["operations"]),
    hints: stringList(parsed["hints"]),
  }
}

/** The status a row records, rolled back first: a rolled-back push applied, then was undone. */
export function migrationStatus(row: Record<string, unknown>): MigrationStatus {
  if (isTrue(row["rolled_back"])) return "rolled_back"
  const recorded = row["status"]
  return recorded === "failed" || recorded === "refused" ? recorded : "applied"
}

/** One history row's outcome. */
export function migrationOutcome(row: Record<string, unknown>): MigrationOutcome {
  return {
    status: migrationStatus(row),
    error: text(row["error_message"]),
    refusal: readRefusal(row["refusal"]),
    superseded: text(row["superseded_at"]) !== null,
  }
}

/** The newest push, when it was refused or failed and nothing has applied since. */
export interface PendingSchemaPush {
  id: number
  status: "failed" | "refused"
  error: string | null
  operations: string[]
  hints: string[]
}

/** What the `schema_push_status` query's one row says is pending, or null when nothing is. */
export function pendingSchemaPush(row: Record<string, unknown> | undefined): PendingSchemaPush | null {
  if (row === undefined) return null
  const status = migrationStatus(row)
  if (status !== "failed" && status !== "refused") return null
  if (text(row["superseded_at"]) !== null) return null
  return {
    id: Number(row["id"] ?? 0),
    status,
    error: text(row["error_message"]),
    operations: stringList(row["operations"]),
    hints: stringList(row["hints"]),
  }
}

/** The Migration History address that shows one migration expanded. */
export function migrationHistoryHref(id: number): string {
  return `/database/migrations?migration=${id}`
}
