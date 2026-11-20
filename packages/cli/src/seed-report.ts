/**
 * What the engine answers a seed with, and how it is printed. Shared by the local arm (the engine
 * here) and the remote arm (a control plane that ran the engine), so both report and exit alike.
 */

import {
  isArrayOf,
  isBoolean,
  isNumber,
  isRecordOf,
  isShape,
  isString,
  nullable,
  optional,
  type Guard,
} from "@supatype/shared"
import { redact } from "./host-database.js"
import { error, info, success } from "./ui/messages.js"

export interface SeedResult {
  ok: boolean
  atomic?: boolean
  files?: Array<{
    file: string
    status: string
    written?: Record<string, number>
    skippedGroups?: string[]
  }>
  error?: SeedFailure
}

/** Why the engine could not seed, or could not read what was seeded. */
export interface SeedFailure {
  kind: string
  message?: string
  remedy?: string | null
  file?: string
  path?: string
}

const isSeedFailure: Guard<SeedFailure> = isShape({
  kind: isString,
  message: optional(isString),
  remedy: optional(nullable(isString)),
  file: optional(isString),
  path: optional(isString),
})

/** The engine's seed result document (schema-engine `seed_command`). */
export const isSeedResult: Guard<SeedResult> = isShape({
  ok: isBoolean,
  atomic: optional(isBoolean),
  files: optional(
    isArrayOf(
      isShape({
        file: isString,
        status: isString,
        written: optional(isRecordOf(isNumber)),
        skippedGroups: optional(isArrayOf(isString)),
      }),
    ),
  ),
  error: optional(isSeedFailure),
})

/**
 * `seed --status`: the latest run of each file, and whether it has changed since. `error` when the
 * engine could not read them, a database it could not reach included.
 */
export interface SeedStatus {
  files?: Array<{ file: string; appliedAt: string; status: string; durationMs: number; drifted: boolean }>
  error?: SeedFailure
}

export const isSeedStatus: Guard<SeedStatus> = isShape({
  error: optional(isSeedFailure),
  files: optional(
    isArrayOf(
      isShape({ file: isString, appliedAt: isString, status: isString, durationMs: isNumber, drifted: isBoolean }),
    ),
  ),
})

/**
 * Print what happened to every file, then the outcome. `where` names the target: a redacted
 * database URL for the engine here, `<ref> (<environment>)` for a control plane.
 *
 * Every file, not just the one that failed: without `--atomic` a failure in the third of
 * five leaves the first two committed, and a report that mentioned only the failure would
 * leave the reader to guess at the rest.
 */
export function report(result: SeedResult, count: number, where: string): number {
  for (const file of result.files ?? []) {
    const rows = Object.entries(file.written ?? {})
      .map(([model, written]) => `${model} ${written}`)
      .join(", ")
    info(`  ${file.file.padEnd(32)} ${file.status}${rows.length > 0 ? `  (${rows})` : ""}`)
    for (const skipped of file.skippedGroups ?? []) {
      info(`    condition was false, skipped: ${skipped}`)
    }
  }

  if (result.ok) {
    success(`Seeded ${count} file(s) into ${where}.`)
    return 0
  }

  const failure = result.error
  if (failure === undefined) {
    error("The seed failed, and the engine said nothing about why.")
    return 1
  }

  return reportSeedFailure(failure)
}

/** Print the engine's failure; its exit code. */
export function reportSeedFailure(failure: SeedFailure): number {
  error(seedFailureText(failure))
  // Nothing ran because nothing could: the environment, not the seed.
  return failure.kind === "connection" || failure.kind === "document" ? 2 : 1
}

/**
 * The engine's error as one message: what failed, where, and the remedy. The engine already writes
 * the remedy into the message of some failures (a column the database does not have), so it is
 * added only when the message does not carry it, or it printed twice.
 */
export function seedFailureText(failure: SeedFailure): string {
  const message = failure.message ?? failure.kind
  const where = [failure.file, failure.path].filter((part) => part !== undefined && part !== "")
  const remedy = failure.remedy ?? undefined
  return (
    message +
    (where.length > 0 ? `\n  at ${where.join(" ")}` : "") +
    (remedy !== undefined && !message.includes(remedy) ? `\n  ${remedy}` : "")
  )
}

/**
 * Print what `seed --status` found; its exit code. An engine that could not reach the database
 * answers with an error beside an empty list, which this used to read as "No seeds have been
 * applied", exit 0, for a database it never connected to.
 */
export function reportSeedStatus(result: SeedStatus, where: string): number {
  if (result.error !== undefined) return reportSeedFailure(result.error)
  const files = result.files ?? []
  if (files.length === 0) {
    info(`No seeds have been applied to ${redact(where)}.`)
    return 0
  }

  for (const entry of files) {
    info(
      `  ${entry.file.padEnd(32)} ${entry.status.padEnd(12)} ${entry.appliedAt}  ` +
        `${entry.durationMs}ms${entry.drifted ? "  changed since it was applied" : ""}`,
    )
  }
  return 0
}
