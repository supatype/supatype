import { useEffect, useState } from "react"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"
import { membershipBase } from "../lib/membership-url.js"

export interface StudioCapability {
  /** The signed-in user's id, so their own row can be shown read-only. */
  userId: string | null
  /** Their Studio role, or null before the check resolves. */
  role: string | null
  /**
   * Whose identity data requests act as. `elevated` means the server is using the
   * service role, so RLS does not apply and the reader is seeing everything.
   */
  mode: "self" | "elevated"
  /** Whether this role may switch modes at all. */
  canElevate: boolean
  canManageMembers: boolean
  /**
   * Whether this caller sees other people's unpublished work.
   *
   * From the server, not inferred here, and it needs its own field because row level security
   * cannot supply it: Studio's data plane goes through the proxy with the service role, which
   * bypasses policies. The draft-visibility setting compiles into those policies, so it binds the
   * API and would not bind the UI. The server answers from the same stored setting, so one source
   * of truth reaches both.
   *
   * False for a project with no versioned models, which has no drafts to show.
   */
  seesDrafts: boolean
  permissions: Record<string, boolean>
}

const UNRESOLVED: StudioCapability = {
  userId: null,
  role: null,
  mode: "self",
  canElevate: false,
  canManageMembers: false,
  seesDrafts: false,
  permissions: {},
}

/**
 * What the signed-in user may do, straight from the server.
 *
 * Never inferred from a role name in the client: the server re-resolves capability
 * from `_supatype.studio_members` on every request, so anything decided here would
 * only ever be a stale guess that the next request contradicts. This drives what
 * the UI offers; the server still refuses what it should.
 */
export function useStudioCapability(): StudioCapability {
  const client = useAdminClient()
  const [capability, setCapability] = useState<StudioCapability>(UNRESOLVED)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const base = membershipBase(client.url).replace(/\/admin$/, "")
        const res = await fetch(`${base}/studio/auth/verify`, {
          credentials: "include",
          headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
        })
        if (!res.ok) return
        const json = (await res.json()) as {
          sub?: string
          role?: string
          mode?: string
          canElevate?: boolean
          seesDrafts?: boolean
          permissions?: Record<string, boolean>
        }
        if (cancelled) return

        const permissions = json.permissions ?? {}
        setCapability({
          userId: json.sub ?? null,
          role: json.role ?? null,
          mode: json.mode === "elevated" ? "elevated" : "self",
          canElevate: json.canElevate === true,
          canManageMembers: permissions["manageMembers"] === true,
          seesDrafts: json.seesDrafts === true,
          permissions,
        })
      } catch {
        // Leave it unresolved: the UI then offers nothing, and the server refuses
        // anything attempted anyway. Failing open here would show controls that
        // cannot work.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client])

  return capability
}
