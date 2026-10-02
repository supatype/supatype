/**
 * Parse and format schema-engine push output (compose subprocess or HTTP).
 */

import { printDiffWarnings } from "./diff-output.js"

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

export interface EnginePushResult {
  status?: string
  operations?: number
  admin_refreshed?: boolean
  message?: string
  /** The schema's warnings (a bucket rule left out, say), then any found once applied. */
  warnings?: string[]
}

/** Extract the engine JSON object from mixed docker compose stdout/stderr. */
export function parseEngineJsonOutput<T>(output: string): T | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue
    try {
      return JSON.parse(candidate) as T
    } catch {
      /* try next line */
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as T
    } catch {
      return null
    }
  }

  return null
}

export function parseEnginePushOutput(output: string): EnginePushResult | null {
  return parseEngineJsonOutput<EnginePushResult>(output)
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
