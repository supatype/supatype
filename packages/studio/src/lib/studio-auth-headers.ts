import type { SupatypeClient } from "@supatype/client"

/** True when Studio routes API calls through a session-aware proxy (no browser service role). */
export function usesSessionProxy(client: { url: string; serviceRoleKey?: string | undefined }): boolean {
  if (client.serviceRoleKey) return false
  const base = client.url.replace(/\/$/, "")
  return base.endsWith("/studio/proxy") || base.includes("/proxy")
}

/** Authorization headers for Studio privileged fetches (service role legacy or user JWT). */
export function studioAuthHeaders(client: SupatypeClient): Record<string, string> {
  if (client.serviceRoleKey) {
    return {
      Authorization: `Bearer ${client.serviceRoleKey}`,
      apikey: client.serviceRoleKey,
    }
  }
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
