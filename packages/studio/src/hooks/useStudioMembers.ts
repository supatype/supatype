import { useCallback, useEffect, useMemo, useState } from "react"
import { membershipBase } from "../lib/membership-url.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"

/** Who may use Studio for this project, and with what capability set. */
export interface StudioMember {
  /** Project user id, or the cloud account id for a platform grant. */
  userId: string
  /** Empty for a cloud account: it has no row in this project's `auth.users`. */
  email: string
  role: string
  /** A grant held by a Supatype Cloud account rather than a project user. */
  platformAccount: boolean
  createdAt: string
  updatedAt: string
}

export interface StudioRoleInfo {
  role: string
  permissions: Record<string, boolean>
}

export interface UseStudioMembersReturn {
  members: StudioMember[]
  roles: StudioRoleInfo[]
  loading: boolean
  /** Why the last call failed, or null. Kept verbatim: the server explains the refusal. */
  error: string | null
  /** Studio role of the given project user, or null when they have no access. */
  roleFor: (userId: string) => string | null
  setRole: (userId: string, role: string) => Promise<boolean>
  revoke: (userId: string) => Promise<boolean>
  refresh: () => void
}

/**
 * Read and edit `_supatype.studio_members` through the membership API.
 *
 * Studio roles are Supatype's own namespace. They are deliberately not the
 * developer's application roles, which live in the caller's own claims and tables
 * and are theirs to manage — writing Studio access into `app_metadata` is how
 * assigning an app role could hand out admin UI access by accident.
 *
 * The server is the authority on every refusal here. This hook does not
 * pre-empt its rules (no self-change, no demoting the last admin) beyond
 * disabling the obvious control, because a client-side copy of them would drift.
 */
export function useStudioMembers(): UseStudioMembersReturn {
  const client = useAdminClient()
  const [members, setMembers] = useState<StudioMember[]>([])
  const [roles, setRoles] = useState<StudioRoleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const base = useMemo(() => membershipBase(client.url), [client.url])

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...studioGatewayHeaders(),
          ...studioAuthHeaders(client),
          ...init?.headers,
        },
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        throw new Error(
          (json["message"] as string | undefined) ??
            (json["error"] as string | undefined) ??
            `Request failed (${res.status})`,
        )
      }
      return json
    },
    [base, client],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const [memberBody, roleBody] = await Promise.all([
          request("/studio-members"),
          request("/studio-roles"),
        ])
        if (cancelled) return
        setMembers(readMembers(memberBody))
        setRoles(readRoles(roleBody))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Could not load Studio membership")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [request, generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  // Refetching rather than patching local state: the server may have applied
  // something other than what was asked (or nothing at all), and the membership
  // list is small.
  const mutate = useCallback(
    async (path: string, init: RequestInit): Promise<boolean> => {
      setError(null)
      try {
        await request(path, init)
        refresh()
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not change Studio access")
        return false
      }
    },
    [request, refresh],
  )

  const setRole = useCallback(
    (userId: string, role: string) =>
      mutate(`/studio-members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    [mutate],
  )

  const revoke = useCallback(
    (userId: string) =>
      mutate(`/studio-members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    [mutate],
  )

  const roleFor = useCallback(
    (userId: string) => members.find((m) => m.userId === userId)?.role ?? null,
    [members],
  )

  return { members, roles, loading, error, roleFor, setRole, revoke, refresh }
}

function readMembers(body: unknown): StudioMember[] {
  const rows = pickArray(body, "members")
  return rows.map((row) => ({
    userId: String(row["userId"] ?? row["id"] ?? ""),
    email: String(row["email"] ?? ""),
    role: String(row["role"] ?? ""),
    platformAccount: row["platformAccount"] === true,
    createdAt: String(row["createdAt"] ?? ""),
    updatedAt: String(row["updatedAt"] ?? ""),
  }))
}

function readRoles(body: unknown): StudioRoleInfo[] {
  const rows = pickArray(body, "roles")
  return rows.map((row) => ({
    role: String(row["role"] ?? ""),
    permissions: (row["permissions"] as Record<string, boolean> | undefined) ?? {},
  }))
}

/**
 * Both hosts answer with the same shape under different wrappers — self-host
 * returns `{ members: [...] }`, the control plane wraps everything in `{ data }`,
 * and the cloud role catalogue is a plain string array.
 */
function pickArray(body: unknown, key: string): Record<string, unknown>[] {
  if (body === null || typeof body !== "object") return []
  const record = body as Record<string, unknown>
  const candidate = record[key] ?? record["data"]

  if (Array.isArray(candidate)) {
    return candidate.map((entry) =>
      typeof entry === "string" ? { role: entry } : (entry as Record<string, unknown>),
    )
  }
  if (candidate !== null && typeof candidate === "object") {
    return pickArray(candidate, key)
  }
  return []
}
