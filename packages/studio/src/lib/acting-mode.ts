/**
 * Whose identity a Studio request acts as (RX4), which the server decides.
 *
 * Content screens ask for no mode, so the server's default applies: Studio for editors and viewers
 * (their Studio role decides what they may do with rows; the app's field rules still apply) and
 * full access for admins and developers. Only a request someone is building, a model's API "Try
 * it", its GraphQL tab and a function's Invoke, asks for a mode, chosen per request in the panel
 * (`send-as.ts`) and never remembered (owner decision 2026-10-21).
 */

export type ActingMode = "self" | "studio" | "elevated"

export const ACTING_MODE_HEADER = "X-Supatype-Acting-Mode"

/** Where an earlier Studio remembered a mode chosen with a content-screen switch, per deployment. */
const STORED_PREFIX = "supatype.studio.actingMode:"

/** `raw` as an acting mode, or null when it names none. */
export function actingModeOf(raw: unknown): ActingMode | null {
  return raw === "self" || raw === "studio" || raw === "elevated" ? raw : null
}

/** The header asking for `mode`. */
export function actingModeHeaders(mode: ActingMode): Record<string, string> {
  return { [ACTING_MODE_HEADER]: mode }
}

/**
 * Forgets any mode an earlier Studio remembered. Nothing reads it now, so a user left acting as
 * themselves is not stuck there; clearing it keeps the stale value from confusing anyone who looks.
 */
export function forgetStoredActingModes(): void {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined) return
    const stale = Array.from({ length: storage.length }, (_, i) => storage.key(i))
      .filter((key): key is string => key !== null && key.startsWith(STORED_PREFIX))
    for (const key of stale) storage.removeItem(key)
  } catch {
    // Storage that throws (private windows, blocked site data) holds nothing to forget.
  }
}
