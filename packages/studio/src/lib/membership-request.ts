import type { SupatypeClient } from "@supatype/client"
import { bodyMessage, isJsonObject, type Guard } from "./json.js"
import { membershipBase } from "./membership-url.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"
import { studioGatewayHeaders } from "./studio-gateway-headers.js"

export interface MembershipInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Sent as JSON. */
  body?: Record<string, unknown>
}

/** Why the server refused, in its own words: `message`, then `error`, then the status. */
function refusalMessage(body: unknown, status: number): string {
  const object = isJsonObject(body) ? body : {}
  const error = object["error"]
  return bodyMessage(object) ?? (typeof error === "string" ? error : undefined) ?? `Request failed (${status})`
}

/**
 * One call to the routes that sit beside `/studio/proxy` (membership, allowed origins, preview
 * links), answering with the body when the guard accepts it.
 *
 * Throws with the server's reason on a refusal, and when a success carries a body the guard does
 * not accept. A body that is not JSON (a 204, say) reads as `null`.
 */
export async function membershipRequest<T>(
  client: SupatypeClient,
  path: string,
  guard: Guard<T>,
  init: MembershipInit = {},
): Promise<T> {
  const res = await fetch(`${membershipBase(client.url)}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: {
      // Only where there is a body to describe. On a GET it says nothing, and it is not a
      // CORS-safelisted value, so it is pure weight on a cross-origin deployment.
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
      ...studioGatewayHeaders(),
      ...studioAuthHeaders(client),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(refusalMessage(body, res.status))
  if (!guard(body)) throw new Error(`Unexpected response from ${path} (HTTP ${res.status})`)
  return body
}
