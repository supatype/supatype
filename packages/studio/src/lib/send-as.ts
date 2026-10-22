import { actingModeHeaders } from "./acting-mode.js"

/**
 * Who a request built in Studio is sent as: a model's API "Try it", its GraphQL tab and a
 * function's Invoke. The one place Studio still chooses an acting mode, per request and never
 * remembered (owner decision 2026-10-21).
 *
 * - `me`: the signed-in Studio user's own token, acting as themselves, so the app's own rules apply
 *   to them as they would in the app.
 * - `anon`: as an anonymous client. The request carries the user's own token, so the proxy knows who
 *   asks, and asks it to act as `anon`, which it does by forwarding the project's anon key instead.
 * - `service`: the service role, full access, for a role that may have it (admins and developers).
 *   The key never reaches the browser: the request carries the user's own token and asks the
 *   Studio proxy to act as the service role, which it does only for a role that holds it.
 * - `token`: a token pasted in, such as another user's, sent as it is.
 */
export type SendAs = "me" | "anon" | "service" | "token"

export const SEND_AS_LABELS: Record<SendAs, string> = {
  me: "Me",
  anon: "Anonymous",
  service: "Service role",
  token: "A token I paste",
}

/** The choices this role is offered, in the order the panel lists them. */
export function sendAsChoices(canElevate: boolean): SendAs[] {
  return canElevate ? ["me", "anon", "service", "token"] : ["me", "anon", "token"]
}

export function isSendAs(value: string): value is SendAs {
  return value === "me" || value === "anon" || value === "service" || value === "token"
}

const bearer = (token: string): Record<string, string> => (token === "" ? {} : { Authorization: `Bearer ${token}` })

/** The headers a request sent as `choice` carries, given the signed-in token and any pasted one. */
export function sendAsHeaders(choice: SendAs, signedIn: string, pasted: string): Record<string, string> {
  switch (choice) {
    case "me": return { ...bearer(signedIn), ...actingModeHeaders("self") }
    case "service": return { ...bearer(signedIn), ...actingModeHeaders("elevated") }
    case "token": return bearer(pasted.trim())
    case "anon": return { ...bearer(signedIn), ...actingModeHeaders("anon") }
  }
}
