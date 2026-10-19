import type { SupatypeClient } from "@supatype/client"
import { isJsonObject, isShape, isString, nullable, optional, type Guard } from "./json.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"
import { authUserListPath, USER_ID_PATTERN, userListTotal, userSearchTerm } from "./auth-user-search.js"

export const SYSTEM_AUTH_USER = "supatype:user"

export function inferAuthUserRelation(
  rawTarget: string,
  fieldName: string,
  label: string,
): boolean {
  if (rawTarget === SYSTEM_AUTH_USER) return true
  if (fieldName === "authUser" || fieldName === "auth_user_id") return true
  if (label.trim().toLowerCase() === "auth user") return true
  return false
}

export interface AuthUserSummary {
  id: string
  email: string
  name: string
}

export interface RelationDisplay {
  label: string
  sublabel?: string
  initials: string
}

export type AuthUser = {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown> | null
}

/** A user as the auth admin API returns one; only the keys Studio reads are checked. */
export const isAuthUser: Guard<AuthUser> = isShape({
  id: isString,
  email: optional(nullable(isString)),
  user_metadata: optional(nullable(isJsonObject)),
})

/** The users in an admin list body (`{ users: [...] }`), skipping any entry that is not one. */
export function authUsersIn(body: unknown): AuthUser[] {
  const users = isJsonObject(body) ? body["users"] : undefined
  return Array.isArray(users) ? users.filter(isAuthUser) : []
}

export function authUserSummary(raw: AuthUser): AuthUserSummary {
  const name = String(raw.user_metadata?.["name"] ?? raw.user_metadata?.["full_name"] ?? "").trim()
  return { id: raw.id, email: raw.email ?? "", name }
}

export function relationDisplayFromAuthUser(summary: AuthUserSummary): RelationDisplay {
  const label = summary.email || summary.name || summary.id
  const display: RelationDisplay = { label, initials: authUserInitials(summary) }
  if (summary.email && summary.name) display.sublabel = summary.name
  return display
}

export function authUserInitials(summary: AuthUserSummary): string {
  if (summary.name) {
    const parts = summary.name.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
    return summary.name.slice(0, 2).toUpperCase()
  }
  if (summary.email) return summary.email.slice(0, 2).toUpperCase()
  return "?"
}

async function authAdminFetch(client: SupatypeClient, path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${client.url}/auth/v1/admin${path}`, {
    headers: { ...studioAuthHeaders(client), "Content-Type": "application/json" },
    credentials: "include",
    ...(signal !== undefined && { signal }),
  })
}

/** One page of users matching a search, and how many match in all. */
export interface AuthUserMatches {
  users: AuthUserSummary[]
  total: number
}

const NO_MATCHES: AuthUserMatches = { users: [], total: 0 }

/**
 * The users matching `term`, searched by the auth server a page at a time (zero based `page`), so
 * every user can be found. An ID is looked up directly, since the server's filter does not search
 * IDs. A refused request reads as no matches, as a picker has nowhere better to say so.
 */
export async function searchAuthUsers(
  client: SupatypeClient,
  term: string,
  at: { page: number; perPage: number },
  signal?: AbortSignal,
): Promise<AuthUserMatches> {
  const filter = userSearchTerm(term)
  if (USER_ID_PATTERN.test(filter)) {
    const user = at.page === 0 ? await fetchAuthUserById(client, filter, signal) : null
    return user ? { users: [user], total: 1 } : NO_MATCHES
  }
  const search = { filter, ...at }
  const res = await authAdminFetch(client, authUserListPath(search), signal)
  if (!res.ok) return NO_MATCHES
  const users = authUsersIn(await res.json()).map(authUserSummary)
  return { users, total: userListTotal(res, search, users.length) }
}

export async function fetchAuthUserById(
  client: SupatypeClient,
  id: string,
  signal?: AbortSignal,
): Promise<AuthUserSummary | null> {
  const res = await authAdminFetch(client, `/users/${encodeURIComponent(id)}`, signal)
  if (!res.ok) return null
  const user = await res.json()
  return isAuthUser(user) ? authUserSummary(user) : null
}

export async function fetchAuthUsersByIds(
  client: SupatypeClient,
  ids: string[],
): Promise<Map<string, RelationDisplay>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const user = await fetchAuthUserById(client, id)
      return user ? [id, relationDisplayFromAuthUser(user)] as const : null
    }),
  )
  return new Map(entries.filter((e): e is [string, RelationDisplay] => e !== null))
}
