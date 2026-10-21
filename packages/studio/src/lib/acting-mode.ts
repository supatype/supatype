/**
 * The acting mode a Studio user has chosen for Studio's requests (RX4).
 *
 * The server decides. Everyone acts as Studio by default: their Studio role decides what they may
 * do with content, the app's row rules do not apply and its field rules do. Anyone may ask to act
 * as themselves instead, a preview of the app's rules, with `X-Supatype-Acting-Mode`; owners,
 * admins and developers may also ask for elevated access, the service role. Studio only remembers
 * what was asked for, per Studio deployment (`scope`, the proxy URL its client talks to), and
 * sends it on every request: the client's own and Studio's direct fetches alike.
 *
 * Kept in `localStorage`, so the choice survives a reload. Storage that throws (private windows,
 * blocked site data) reads as no choice, which is the server's default.
 */

export type ActingMode = "self" | "studio" | "elevated"

export const ACTING_MODE_HEADER = "X-Supatype-Acting-Mode"

const KEY_PREFIX = "supatype.studio.actingMode:"

/** `raw` as an acting mode, or null when it names none. */
export function actingModeOf(raw: unknown): ActingMode | null {
  return raw === "self" || raw === "studio" || raw === "elevated" ? raw : null
}

/** The mode chosen for `scope`, or null when none was: the server's default then applies. */
export function chosenActingMode(scope: string): ActingMode | null {
  try {
    return actingModeOf(globalThis.localStorage?.getItem(KEY_PREFIX + scope))
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
