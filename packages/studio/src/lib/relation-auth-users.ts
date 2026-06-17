import type { SupatypeClient } from "@supatype/client"
import { studioAuthHeaders } from "./studio-auth-headers.js"

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

type GoTrueUser = {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
}

export function authUserSummary(raw: GoTrueUser): AuthUserSummary {
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

async function authAdminFetch(client: SupatypeClient, path: string): Promise<Response> {
  return fetch(`${client.url}/auth/v1/admin${path}`, {
    headers: { ...studioAuthHeaders(client), "Content-Type": "application/json" },
    credentials: "include",
  })
}

export async function fetchAuthUsers(
  client: SupatypeClient,
  term: string,
  limit = 30,
): Promise<AuthUserSummary[]> {
  const res = await authAdminFetch(client, "/users?page=1&per_page=200")
  if (!res.ok) return []
  const data = await res.json() as { users?: GoTrueUser[] }
  const q = term.trim().toLowerCase()
  const results: AuthUserSummary[] = []
  for (const raw of data.users ?? []) {
    const summary = authUserSummary(raw)
    if (!q) {
      results.push(summary)
    } else if (summary.email.toLowerCase().includes(q) || summary.name.toLowerCase().includes(q)) {
      results.push(summary)
    }
    if (results.length >= limit) break
  }
  return results
}

export async function fetchAuthUserById(
  client: SupatypeClient,
  id: string,
): Promise<AuthUserSummary | null> {
  const res = await authAdminFetch(client, `/users/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  return authUserSummary(await res.json() as GoTrueUser)
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
