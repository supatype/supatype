import type { SupatypeClient } from "@supatype/client"
/** True when Studio routes API calls through a session-aware proxy. */
export function usesSessionProxy(client: { url: string }): boolean {
  const base = client.url.replace(/\/$/, "")
  return base.endsWith("/studio/proxy") || base.includes("/proxy")
}

/**
 * Authorization headers for Studio's privileged fetches.
 *
 * Always the signed-in user's token, never a service role key. The key lives on
 * the server behind `/studio/proxy`, which resolves the caller's Studio
 * membership, applies their role's permissions, decides the acting identity and
 * records elevated access. A key sent from here would bypass all four. No acting
 * mode goes with them, so the server's default for the caller's role applies (`acting-mode.ts`).
 */
export function studioAuthHeaders(client: SupatypeClient): Record<string, string> {
  const token = signedInToken(client)
  return token === "" ? {} : { Authorization: `Bearer ${token}`, apikey: token }
}

/**
 * The signed-in Studio user's access token, or "" when nobody is signed in.
 *
 * What every request builder (the REST explorer, a model's API page, Invoke) starts from, so the
 * first request goes out as the person at the keyboard rather than anonymous.
 */
export function signedInToken(client: SupatypeClient): string {
  return client.auth.currentAccessToken ?? ""
}

/** PostgREST / Kong fetch headers (auth + optional profile headers). */
export function studioRestHeaders(
  client: SupatypeClient,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    ...studioAuthHeaders(client),
    ...extra,
  }
}
