/**
 * Kong `key-auth` for `/studio-config` and `/sql` when `STUDIO_GATEWAY_KEY` is set at deploy time.
 * Browser: set `VITE_STUDIO_GATEWAY_KEY` to the same value (build-time embed).
 */
export function studioGatewayHeaders(): Record<string, string> {
  const k = (import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_STUDIO_GATEWAY_KEY"]
  if (typeof k === "string" && k.length > 0) {
    return { apikey: k }
  }
  return {}
}
