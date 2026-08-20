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
 * records elevated access. A key sent from here would bypass all four.
 */
export function studioAuthHeaders(client: SupatypeClient): Record<string, string> {
  const token = client.auth.currentAccessToken
  if (token !== null && token.length > 0) {
    return { Authorization: `Bearer ${token}`, apikey: token }
  }
  return {}
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
