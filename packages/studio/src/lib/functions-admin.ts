import type { SupatypeClient } from "@supatype/client"
import { bodyErrorText, readJsonObject } from "./json.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"

/**
 * A functions admin API refusal, as an error naming what failed, the HTTP status and the server's
 * own words when it gave any. A refusal is never read as an empty answer: that is how a server
 * without the route came to say "No functions deployed".
 */
export async function functionsAdminError(res: Response, what: string): Promise<Error> {
  const said = bodyErrorText(await readJsonObject(res))
  const status = res.statusText === "" ? `HTTP ${res.status}` : `HTTP ${res.status} ${res.statusText}`
  return new Error(said === undefined ? `${what} (${status})` : `${what} (${status}): ${said}`)
}

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
