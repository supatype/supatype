import { useCallback, useEffect, useMemo, useState } from "react"
import { membershipBase } from "../lib/membership-url.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
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
  const base = useMemo(() => membershipBase(client.url), [client.url])
  const [data, setData] = useState<CorsOrigins | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const request = useCallback(
    async (init?: RequestInit): Promise<CorsOrigins> => {
      const res = await fetch(`${base}/cors-origins`, {
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
        throw new Error((json["message"] as string | undefined) ?? `Request failed (${res.status})`)
      }
      return json as unknown as CorsOrigins
    },
    [base, client],
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
    async (init: RequestInit): Promise<boolean> => {
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
    save: (origins) => change({ method: "PUT", body: JSON.stringify({ origins }) }),
    reset: () => change({ method: "DELETE" }),
    refresh: () => setGeneration((g) => g + 1),
  }
}
