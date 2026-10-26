/**
 * The acting mode an owner or admin has chosen for Studio's requests (RX4).
 *
 * The server decides: an owner or admin acts elevated by default, as the service role, and may ask
 * to act as themselves instead with `X-Supatype-Acting-Mode`; nobody else may elevate. Studio only
 * remembers what was asked for, per Studio deployment (`scope`, the proxy URL its client talks to),
 * and sends it on every request: the client's own and Studio's direct fetches alike.
 *
 * Kept in `localStorage`, so the choice survives a reload. Storage that throws (private windows,
 * blocked site data) reads as no choice, which is the server's default.
 */

export type ActingMode = "self" | "elevated"

export const ACTING_MODE_HEADER = "X-Supatype-Acting-Mode"

const KEY_PREFIX = "supatype.studio.actingMode:"

/** The mode chosen for `scope`, or null when none was: the server's default then applies. */
export function chosenActingMode(scope: string): ActingMode | null {
  try {
    const value = globalThis.localStorage?.getItem(KEY_PREFIX + scope)
    return value === "self" || value === "elevated" ? value : null
  } catch {
    return null
  }
}

/** Remember `mode` for `scope`; null forgets the choice. */
export function chooseActingMode(scope: string, mode: ActingMode | null): void {
  try {
    if (mode === null) globalThis.localStorage?.removeItem(KEY_PREFIX + scope)
    else globalThis.localStorage?.setItem(KEY_PREFIX + scope, mode)
  } catch {
    // Nowhere to keep it: requests carry no mode, and the server's default applies.
  }
}

/** The header asking for the chosen mode, or none when nothing was chosen. */
export function actingModeHeaders(scope: string): Record<string, string> {
  const mode = chosenActingMode(scope)
  return mode === null ? {} : { [ACTING_MODE_HEADER]: mode }
}
