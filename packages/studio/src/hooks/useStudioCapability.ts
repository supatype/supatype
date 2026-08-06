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
  permissions: Record<string, boolean>
}

const UNRESOLVED: StudioCapability = {
  userId: null,
  role: null,
  mode: "self",
  canElevate: false,
  canManageMembers: false,
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
