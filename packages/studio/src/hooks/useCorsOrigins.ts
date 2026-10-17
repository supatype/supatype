import { useCallback, useEffect, useState } from "react"
import {
  isArrayOf,
  isBoolean,
  isOneOf,
  isShape,
  isString,
  nullable,
  type Guard,
} from "../lib/json.js"
import { membershipRequest, type MembershipInit } from "../lib/membership-request.js"
import { useAdminClient } from "./useAdminClient.js"

/** What the gateway enforces, and where each part comes from. */
export interface CorsOrigins {
  /** Every origin allowed now, platform origins included. */
  origins: string[]
  /** "saved" while a list saved here is in force, else "default". */
  source: "saved" | "default"
  /** What is in force with nothing saved: the site URL, then configuration. */
  default: string[]
  /** The site URL's origin, always part of the default. */
  siteOrigin: string
  /** `api.corsOrigins` and SUPATYPE_CORS_ALLOW_ORIGINS (and on Cloud, the project's settings). */
  configured: string[]
  /** Origins the host needs whatever is saved (Cloud's Studio). */
  platform: string[]
  /** The saved list, or null. */
  saved: string[] | null
  updatedAt: string | null
  mode: string
  /** False in dev mode, which allows every origin whatever the list says. */
  enforced: boolean
  /** False when the deployment has nowhere to save a list. */
  editable: boolean
}

const isOriginList = isArrayOf(isString)

const isCorsOrigins: Guard<CorsOrigins> = isShape({
  origins: isOriginList,
  source: isOneOf(["saved", "default"] as const),
  default: isOriginList,
  siteOrigin: isString,
  configured: isOriginList,
  platform: isOriginList,
  saved: nullable(isOriginList),
  updatedAt: nullable(isString),
  mode: isString,
  enforced: isBoolean,
  editable: isBoolean,
})

export interface UseCorsOriginsReturn {
  data: CorsOrigins | null
  loading: boolean
  /** Why the last call failed, verbatim from the server. */
  error: string | null
  save: (origins: string[]) => Promise<boolean>
  reset: () => Promise<boolean>
  refresh: () => void
}

/**
 * The allowed browser origins, read and changed through the gateway's `/admin/cors-origins` (on
 * Cloud, the control plane's project route, which forwards to the same API). The server is the
 * authority on what is valid and who may change it; this hook only carries its answers.
 */
export function useCorsOrigins(): UseCorsOriginsReturn {
  const client = useAdminClient()
  const [data, setData] = useState<CorsOrigins | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const request = useCallback(
    (init?: MembershipInit): Promise<CorsOrigins> => membershipRequest(client, "/cors-origins", isCorsOrigins, init),
    [client],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    request()
      .then((next) => { if (!cancelled) setData(next) })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [request, generation])

  const change = useCallback(
    async (init: MembershipInit): Promise<boolean> => {
      setError(null)
      try {
        setData(await request(init))
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [request],
  )

  return {
    data,
    loading,
    error,
    save: (origins) => change({ method: "PUT", body: { origins } }),
    reset: () => change({ method: "DELETE" }),
    refresh: () => setGeneration((g) => g + 1),
  }
}
