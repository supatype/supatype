import { useEffect, useState } from "react"
import { isBoolean, isJsonObject, isRecordOf } from "../lib/json.js"
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
  /**
   * On Cloud, whether the caller has linked the project login they act as in self mode. A member
   * with no link is refused project data until they link one. Null where the host has no links:
   * on self-host the caller already is a project user.
   */
  identityLink: { linked: boolean; email: string | null } | null
}

const UNRESOLVED: StudioCapability = {
  userId: null,
  role: null,
  mode: "self",
  canElevate: false,
  canManageMembers: false,
  seesDrafts: false,
  permissions: {},
  identityLink: null,
}

/** The server's `identityLink`, or null when it sent none or sent something else. */
function readIdentityLink(raw: unknown): StudioCapability["identityLink"] {
  if (!isJsonObject(raw)) return null
  const { linked, email } = raw
  if (typeof linked !== "boolean") return null
  return { linked, email: typeof email === "string" ? email : null }
}

const isPermissionMap = isRecordOf(isBoolean)

/** What the verify route's answer grants. A key it leaves out, or sends as another type, grants nothing. */
function capabilityFrom(json: Record<string, unknown>): StudioCapability {
  const { sub, role, mode, canElevate, seesDrafts } = json
  const permissions = isPermissionMap(json["permissions"]) ? json["permissions"] : {}
  return {
    userId: typeof sub === "string" ? sub : null,
    role: typeof role === "string" ? role : null,
    mode: mode === "elevated" ? "elevated" : "self",
    canElevate: canElevate === true,
    canManageMembers: permissions["manageMembers"] === true,
    seesDrafts: seesDrafts === true,
    permissions,
    identityLink: readIdentityLink(json["identityLink"]),
  }
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
        const json = await res.json()
        if (cancelled || !isJsonObject(json)) return
        setCapability(capabilityFrom(json))
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
