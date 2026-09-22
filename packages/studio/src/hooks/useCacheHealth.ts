import { useEffect, useRef, useState } from "react"
import { useStudioClient } from "../StudioCore.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import {
  hitRateOver,
  type KeyspaceStats,
  type RowCacheStatus,
  type Sample,
  type WindowedRate,
} from "../lib/cache-health.js"

export interface CacheHealth {
  keyspace: KeyspaceStats | null
  rowCache: RowCacheStatus | null
  /** Hit rate over the last polling interval, not since the segment started. Rule 1. */
  recent: WindowedRate
  rowCacheRecent: WindowedRate
  loading: boolean
  /** A real failure. "Unavailable" and "off" arrive as data, not as errors. */
  error: string | null
}

const POLL_MS = 10_000

/**
 * Polls the two statistics endpoints and turns their cumulative counters into a rate.
 *
 * The polling is not for liveness, it is what makes the numbers mean anything: hits and misses
 * count since the segment started and are not reset by reading, so a hit rate can only be computed
 * from a delta between two reads. One sample is not enough, which is why the first render shows a
 * rate of "—" rather than a number — and why that is correct rather than a loading state that
 * forgot to finish.
 *
 * A 404 is not an error here. An older server has neither route, and a Studio talking to one
 * should render the panels as unavailable rather than a red banner about a URL nobody asked for.
 */
export function useCacheHealth(enabled = true): CacheHealth {
  const client = useStudioClient()
  const [keyspace, setKeyspace] = useState<KeyspaceStats | null>(null)
  const [rowCache, setRowCache] = useState<RowCacheStatus | null>(null)
  const [recent, setRecent] = useState<WindowedRate>({ pct: null, hits: 0, misses: 0, windowMs: 0 })
  const [rowCacheRecent, setRowCacheRecent] = useState<WindowedRate>({
    pct: null,
    hits: 0,
    misses: 0,
    windowMs: 0,
  })
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)

  const lastKeyspace = useRef<Sample | null>(null)
  const lastRowCache = useRef<Sample | null>(null)

  useEffect(() => {
    if (!enabled) return
    let live = true

    const get = async <T,>(path: string): Promise<T | null> => {
      const r = await fetch(`${client.url}/admin/v1/${path}`, {
        headers: studioAuthHeaders(client),
        credentials: "include",
      })
      // 404: a server without these routes. 503: a deployment with no database behind them.
      // Both mean "no numbers", which the panels render as a state of their own.
      if (r.status === 404 || r.status === 503) return null
      if (!r.ok) throw new Error(`${path}: ${r.status}`)
      return (await r.json()) as T
    }

    const tick = async (): Promise<void> => {
      try {
        const [ks, rc] = await Promise.all([
          get<KeyspaceStats>("cache/keyspace"),
          get<RowCacheStatus>("cache/rowcache"),
        ])
        if (!live) return
        const at = Date.now()
        if (ks) {
          setRecent(hitRateOver(lastKeyspace.current, { hits: ks.hits_total, misses: ks.misses_total, at }))
          lastKeyspace.current = { hits: ks.hits_total, misses: ks.misses_total, at }
        }
        if (rc) {
          setRowCacheRecent(
            hitRateOver(lastRowCache.current, { hits: rc.hits_total, misses: rc.misses_total, at }),
          )
          lastRowCache.current = { hits: rc.hits_total, misses: rc.misses_total, at }
        }
        setKeyspace(ks)
        setRowCache(rc)
        setError(null)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Failed to read cache statistics")
      } finally {
        if (live) setLoading(false)
      }
    }

    void tick()
    const id = setInterval(() => void tick(), POLL_MS)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [client, enabled])

  return { keyspace, rowCache, recent, rowCacheRecent, loading, error }
}
