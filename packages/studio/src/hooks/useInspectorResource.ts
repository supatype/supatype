import { useCallback, useEffect, useRef, useState } from "react"
import { bodyMessage, readJsonObject, type Guard } from "../lib/json.js"
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

/**
 * The `data` of a `{ data }` answer when the guard accepts it, or the failure a refusal describes.
 * An empty or non-JSON body reads as `{}`: it still has a status worth reporting.
 */
export async function readInspectorJson<T>(
  res: Response,
  guard: Guard<T>,
): Promise<{ data: T } | { failure: InspectorFailure }> {
  const body = await readJsonObject(res)
  const data = body["data"]
  if (res.ok && guard(data)) return { data }
  if (res.ok && data !== undefined) {
    return { failure: { status: res.status, code: null, message: `Unexpected response (${res.status})` } }
  }
  const code = body["error"]
  return {
    failure: {
      status: res.status,
      code: typeof code === "string" ? code : null,
      message: bodyMessage(body) ?? `Request failed (${res.status})`,
    },
  }
}

/** `guard` checks each answer's `data`; pass a module-level constant so the refresh stays stable. */
export function useInspectorResource<T>(
  projectFetch: ProjectFetch,
  path: string,
  intervalMs: number | null,
  guard: Guard<T>,
): InspectorResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [failure, setFailure] = useState<InspectorFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)

  const refresh = useCallback(() => {
    const request = ++latest.current
    void (async () => {
      try {
        const answer = await readInspectorJson(await projectFetch(path), guard)
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
  }, [projectFetch, path, guard])

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
