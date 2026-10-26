import { HttpError } from "./http.js"
import type { StudioCaller } from "./studio-caller.js"

/**
 * How this control plane reaches realtime's internal admin API.
 *
 * `REALTIME_ADMIN_URL` is set by the compose file only when realtime runs, so its absence means
 * realtime is off for the project. The credential is the project's service-role key, which realtime
 * verifies with the same `JWT_SECRET` it verifies subscribers with.
 */

export const REALTIME_ADMIN_URL_ENV = "REALTIME_ADMIN_URL"
export const SERVICE_ROLE_KEY_ENV = "SUPATYPE_SERVICE_ROLE_KEY"

/** The payload views, narrowest first. */
export type PayloadView = "none" | "redacted" | "viewer" | "delivered"

export interface RealtimeAdmin {
  url: string
  serviceRoleKey: string
}

/** Where realtime's admin API is, or the refusal that says why it cannot be reached. */
export function realtimeAdmin(): RealtimeAdmin {
  const url = process.env[REALTIME_ADMIN_URL_ENV]?.trim() ?? ""
  if (url === "") {
    throw new HttpError(501, "realtime_disabled", "Realtime is turned off for this project (database.external.realtime)")
  }
  const serviceRoleKey = process.env[SERVICE_ROLE_KEY_ENV]?.trim() ?? ""
  if (serviceRoleKey === "") {
    throw new HttpError(503, "not_configured", `${SERVICE_ROLE_KEY_ENV} is not set on the control plane`)
  }
  return { url: url.replace(/\/$/, ""), serviceRoleKey }
}

/**
 * The view a caller gets: the one they asked for if it is no wider than what they may have, else
 * what they may have.
 *
 * `viewer` and `redacted` are never both permitted: one judges rows as the viewer, the other shows
 * every row with restricted columns removed. Asking for the one not permitted gets metadata only,
 * since neither is narrower than the other.
 */
export function chooseView(requested: string | null, permitted: PayloadView): PayloadView {
  if (requested === null || requested === "" || requested === permitted || requested === "delivered") return permitted
  if (requested === "none") return "none"
  if (permitted === "delivered" && (requested === "viewer" || requested === "redacted")) return requested
  return "none"
}

/** Self-host: elevated callers see deliveries as received; everyone else, as themselves. */
export function permittedView(caller: StudioCaller): PayloadView {
  return caller.elevated ? "delivered" : "viewer"
}

/** Forward one request to realtime's admin API, as the service role, for `caller`. */
export async function callRealtime(
  admin: RealtimeAdmin,
  path: string,
  caller: StudioCaller,
  init: { method?: string; body?: string; viewer?: boolean; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${admin.serviceRoleKey}` }
  if (caller.actor !== null) headers["X-Supatype-Studio-Actor"] = caller.actor
  if (init.viewer === true && caller.viewerAuthorization !== null) {
    headers["X-Supatype-Viewer-Authorization"] = caller.viewerAuthorization
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json"
  try {
    return await fetch(`${admin.url}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined && { body: init.body }),
      ...(init.signal !== undefined && { signal: init.signal }),
    })
  } catch (err) {
    if (init.signal?.aborted === true) throw err
    throw new HttpError(503, "realtime_unavailable", "Realtime's admin API could not be reached")
  }
}
