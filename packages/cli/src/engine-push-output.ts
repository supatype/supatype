/**
 * Parse and format schema-engine push output (compose subprocess or HTTP).
 */

export interface EnginePushResult {
  status?: string
  operations?: number
  admin_refreshed?: boolean
  message?: string
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
      return "Schema up to date — Studio metadata synced."
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
