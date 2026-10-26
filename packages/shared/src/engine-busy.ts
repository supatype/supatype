/** The `reason` the engine gives a refusal over its lock (another push, adopt, rebaseline or rollback). */
export const ENGINE_BUSY = "engine_busy"

/**
 * The engine's sentence for that refusal, for an engine or a server that does not name it. The list
 * of writers grew when rollback took the lock ("another push, adopt or rebaseline", then "another
 * push, adopt, rebaseline or rollback"), so any such list that starts with a push matches, up to
 * the end of its line.
 */
export const ENGINE_BUSY_WORDING = /another push(?:,? (?:or )?(?:adopt|rebaseline|rollback))* is running[^\n]*/i

/** The engine's busy sentence in `text` (log lines and an `Error: ` prefix left out), or undefined. */
export function engineBusySentence(text: string): string | undefined {
  return ENGINE_BUSY_WORDING.exec(text)?.[0]?.trim()
}
