/**
 * Parse and format schema-engine push output (compose subprocess or HTTP).
 */

import { printDiffWarnings } from "./diff-output.js"
import { findJsonLine } from "./engine-json-line.js"
import { isEnginePushResult } from "./engine-answers.js"
import type { Guard } from "@supatype/shared"

/**
 * Print what a push warned about, less anything the diff before it already showed.
 *
 * Every caller of `/push` reports through here. The warnings used to reach only `supatype diff`, so
 * a push said nothing about a bucket operation it had just made unreachable, and the ones found
 * after applying were not shown anywhere.
 */
export function printPushWarnings(
  result: Pick<EnginePushResult, "warnings">,
  alreadyShown: readonly string[] = [],
): void {
  const shown = new Set(alreadyShown)
  printDiffWarnings({ warnings: (result.warnings ?? []).filter((w) => !shown.has(w)) })
}

/**
 * Say that a push applied: one line with the operation count when the engine gave one, then what
 * it warned about. Every engine dev applies through (the compose container, `overrides.engine` and
 * native dev's binary) reports here, so none of them drops the count the others print.
 */
export function reportAppliedPush(result: EnginePushResult): void {
  console.log(`[supatype] ${formatEnginePushMessage(result)}`)
  printPushWarnings(result)
}

export interface EnginePushResult {
  status?: string
  operations?: number
  admin_refreshed?: boolean
  message?: string
  /** The migration's name, when one was applied. */
  name?: string
  /** The schema's warnings (a bucket rule left out, say), then any found once applied. */
  warnings?: string[]
  /**
   * What a control plane made of this schema's cache declaration. Absent from an engine push and
   * from a control plane too old to send it, which is why every reader of it has to treat absence
   * as "nothing to say" rather than as an empty declaration.
   */
  cache?: { tables?: string[]; honoured?: boolean }
}

/**
 * The engine's answer in mixed docker compose stdout/stderr: the first line that is a JSON object
 * `guard` accepts, else the whole output when it is one (pretty-printed). Null when there is none.
 */
export function parseEngineJsonOutput<T>(output: string, guard: Guard<T>): T | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  const line = findJsonLine(trimmed, guard)
  if (line !== undefined && guard(line)) return line

  if (trimmed.startsWith("{")) {
    try {
      const whole = JSON.parse(trimmed)
      return guard(whole) ? whole : null
    } catch {
      return null
    }
  }

  return null
}

export function parseEnginePushOutput(output: string): EnginePushResult | null {
  return parseEngineJsonOutput(output, isEnginePushResult)
}

/** Human-readable one-liner for successful push (matches `supatype push` tone). */
export function formatEnginePushMessage(result: EnginePushResult): string {
  if (result.status === "up_to_date") {
    if (result.admin_refreshed) {
      return "Schema up to date, Studio metadata synced."
    }
    return "Schema up to date."
  }

  const ops = result.operations
  if (typeof ops === "number" && ops > 0) {
    return `Applied ${ops} operation(s).`
  }

  return result.message?.trim() || "Schema applied."
}

const COMPOSE_PROGRESS_LINE =
  /^Container\s+.+\s+(Running|Waiting|Healthy|Created|Starting|Started|Exited|Stopped)\s*$/i

export function isComposeProgressLine(line: string): boolean {
  return COMPOSE_PROGRESS_LINE.test(line.trim())
}

/** Drop docker compose progress noise; keep engine JSON and real errors. */
export function filterComposeNoise(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (isComposeProgressLine(t)) return false
      return true
    })
    .join("\n")
    .trim()
}
