import { isJsonObject } from "./json.js"

/**
 * What Studio says when a Studio role cannot do something: one sentence naming the role and what it
 * cannot do, then who can. It replaces the upstream's own refusal ("403", "Auth API error",
 * "Forbidden: service_role required"), which says nothing a reader can act on.
 */

/** The people to ask, by the permission that was missing (the shared role matrix's holders). */
function whoToAsk(permission: string): string {
  if (permission === "manageMembers") return "Ask a Studio admin."
  if (permission === "write") return "Ask a Studio admin, developer or editor."
  return "Ask a Studio admin or developer."
}

/** What a role refused `permission` is told, `activity` being what it tried ("manage the response cache"). */
export interface RoleRefusal {
  /** The sentence that names the role and what it cannot do. */
  headline: string
  /** Who can do it instead. */
  ask: string
}

export function roleRefusal(role: string | null, permission: string, activity: string): RoleRefusal {
  const who = role === null ? "Your Studio role" : `Your Studio role (${role})`
  return { headline: `${who} can't ${activity}.`, ask: whoToAsk(permission) }
}

/** The refusal as one line, for an error banner. */
export function roleRefusalText(refusal: RoleRefusal): string {
  return `${refusal.headline} ${refusal.ask}`
}

/**
 * The refusals that are about the caller's Studio role: the proxy's own (`Studio role "editor"
 * cannot perform this request`) and a service-role-only upstream refusing a token that is not the
 * service role. Any other 403, such as the auth server's "User not allowed", is that upstream's own
 * answer and is shown as it is.
 */
const ROLE_REFUSALS = [/^Studio role "/, /service_role required/]

/** The message a refusal body carries, under whichever key its upstream uses. */
function refusalMessage(body: unknown): string | null {
  if (!isJsonObject(body)) return null
  const text = body["error"] ?? body["message"] ?? body["msg"]
  return typeof text === "string" ? text : null
}

/** Whether `res` is the Studio proxy, or an upstream behind it, refusing the caller's role. */
export async function isRoleRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  const text = refusalMessage(await res.clone().json().catch(() => null))
  return text !== null && ROLE_REFUSALS.some((pattern) => pattern.test(text))
}

/** The error for a failed response: a role refusal reads as `refused`; anything else names its status. */
export async function proxyFailure(res: Response, refused: string): Promise<Error> {
  return new Error((await isRoleRefusal(res)) ? refused : `The request failed (HTTP ${res.status}).`)
}

/** `res` itself, unless it is a role refusal, which throws `refused`. */
export async function unlessRoleRefused(res: Response, refused: string): Promise<Response> {
  if (await isRoleRefusal(res)) throw new Error(refused)
  return res
}
