import type { SupatypeClient } from "@supatype/client"
import { studioAuthHeaders } from "./studio-auth-headers.js"

/**
 * A request to the functions admin API (each function's list entry, logs and env), at its own
 * address under the admin API, /admin/v1/functions, as the signed-in user. It used to be
 * /functions/v1/admin, where it hid a project function named "admin".
 */
export function functionsAdminFetch(client: SupatypeClient, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${client.url}/admin/v1/functions${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...studioAuthHeaders(client),
      ...init?.headers,
    },
  })
}
