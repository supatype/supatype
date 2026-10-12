import type { IncomingMessage } from "node:http"
import { verifyToken, type JwtClaims } from "../auth.js"
import { AdminError } from "./http.js"

/**
 * Who may call the admin API: the service role, and only the service role.
 *
 * This is the boundary in both deployment modes. Neither the compose network nor a Cloud project's
 * namespace keeps other workloads away from the port, so the token is what does. The control planes
 * hold the project's service-role key and act for Studio users; nothing else should.
 */

/** The header naming the Studio user a control plane is acting for. */
export const ACTOR_HEADER = "x-supatype-studio-actor"

/** The header carrying the Studio viewer's own project token, for the `viewer` payload view. */
export const VIEWER_HEADER = "x-supatype-viewer-authorization"

/** The bearer token of an `Authorization`-style header value, or null. */
export function bearer(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null
  const token = value.slice("Bearer ".length).trim()
  return token === "" ? null : token
}

/** Refuse the request unless it carries a service-role token signed with `secret`. */
export function requireServiceRole(req: IncomingMessage, secret: string): void {
  const token = bearer(req.headers.authorization)
  const claims = token === null ? null : verifyToken(token, secret)
  if (!claims) throw new AdminError(401, "unauthorized", "A service-role bearer token is required")
  if (claims.role !== "service_role") {
    throw new AdminError(403, "forbidden", "The realtime admin API answers only the service role")
  }
}

/** The Studio user the caller acts for, or "unknown" when the control plane named nobody. */
export function actorOf(req: IncomingMessage): string {
  const value = req.headers[ACTOR_HEADER]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "unknown"
}

/** The Studio viewer's verified claims, from {@link VIEWER_HEADER}, or null when absent or invalid. */
export function viewerClaims(req: IncomingMessage, secret: string): JwtClaims | null {
  const token = bearer(req.headers[VIEWER_HEADER])
  return token === null ? null : verifyToken(token, secret)
}
