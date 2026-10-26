/**
 * The engine prints its answer, and a refusal's reason, as one JSON object on a line of its own,
 * among log lines and Docker's. Every reader of that output finds the line here.
 */

/** A JSON object as read off a line, before anyone has checked its fields. */
export type JsonObject = Readonly<Record<string, unknown>>

/** The first line of `output` that is a JSON object `accept` takes, or undefined when none is. */
export function findJsonLine(output: string, accept: (value: JsonObject) => boolean = () => true): JsonObject | undefined {
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === "object" && parsed !== null && accept(parsed as JsonObject)) return parsed as JsonObject
    } catch {
      /* not this line */
    }
  }
  return undefined
}
