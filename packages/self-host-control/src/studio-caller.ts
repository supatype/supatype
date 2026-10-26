import type { IncomingMessage } from "node:http"

/**
 * The Studio user a request acts for, as the gateway named them.
 *
 * The gateway's Studio proxy sets these headers from the verified session and removes any copy a
 * browser sent (supatype-auth `studioauth/identity.go`). They are believed here only because every
 * request has already presented the secret only the gateway holds (`auth.ts`); a caller able to
 * forge that already holds the service role.
 */
export interface StudioCaller {
  /** The Studio user's id (the JWT `sub`), or null for a caller the gateway did not name. */
  actor: string | null
  role: string | null
  /** Whether the user holds elevated access, which decides whether they may see others' data. */
  elevated: boolean
  /** `Bearer <their own token>`, sent only for a user acting as themselves. */
  viewerAuthorization: string | null
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

export function studioCaller(req: IncomingMessage): StudioCaller {
  return {
    actor: header(req, "x-supatype-studio-actor"),
    role: header(req, "x-supatype-studio-role"),
    elevated: header(req, "x-supatype-studio-elevated") === "true",
    viewerAuthorization: header(req, "x-supatype-viewer-authorization"),
  }
}
