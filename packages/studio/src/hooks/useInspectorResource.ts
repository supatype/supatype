import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectFetch } from "./usePlatformApi.js"

/**
 * One of the Realtime Inspector's JSON resources (channels, connections), refreshed on an interval
 * while the tab is visible.
 *
 * Unlike `useApiQuery`, a refresh keeps the rows on screen until the new ones arrive: a table that
 * blanks every five seconds cannot be read.
 */

/** Why a resource could not be read: the control plane's `{ error, message }`, with its status. */
export interface InspectorFailure {
  status: number | null
  code: string | null
  message: string
}

export interface InspectorResource<T> {
  data: T | null
  failure: InspectorFailure | null
  loading: boolean
  refresh: () => void
}

/** The `data` of a `{ data }` answer, or the failure a refusal describes. */
export async function readInspectorJson<T>(res: Response): Promise<{ data: T } | { failure: InspectorFailure }> {
  let body: { data?: T; error?: string; message?: string } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    // An empty or non-JSON body still has a status worth reporting.
  }
  if (res.ok && body.data !== undefined) return { data: body.data }
  return {
    failure: { status: res.status, code: body.error ?? null, message: body.message ?? `Request failed (${res.status})` },
  }
}

export function useInspectorResource<T>(
  projectFetch: ProjectFetch,
  path: string,
  intervalMs: number | null,
): InspectorResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [failure, setFailure] = useState<InspectorFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)

  const refresh = useCallback(() => {
    const request = ++latest.current
    void (async () => {
      try {
        const answer = await readInspectorJson<T>(await projectFetch(path))
        if (request !== latest.current) return
        if ("data" in answer) {
          setData(answer.data)
          setFailure(null)
        } else {
          setFailure(answer.failure)
        }
      } catch (err) {
        if (request === latest.current) {
          setFailure({ status: null, code: null, message: err instanceof Error ? err.message : "Network error" })
        }
      } finally {
        if (request === latest.current) setLoading(false)
      }
    })()
  }, [projectFetch, path])

  useEffect(() => {
    refresh()
    if (intervalMs === null) return
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh()
    }, intervalMs)
    return () => {
      clearInterval(timer)
      latest.current++
    }
  }, [refresh, intervalMs])

  return { data, failure, loading, refresh }
}
