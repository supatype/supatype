import { useEffect, useRef, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import { useStudioClient } from "../StudioCore.js"
import {
  isArrayOf,
  isBoolean,
  isNumber,
  isOneOf,
  isShape,
  isString,
  nullable,
  optional,
  readJson,
  type Guard,
} from "../lib/json.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import {
  hitRateOver,
  type KeyspaceStats,
  type RowCacheDatabase,
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

const isCount = isNumber
const isNullableCount = nullable(isNumber)

/** The keyspace body, as the auth server's `keyspaceStats` struct writes it. */
const isKeyspaceStats: Guard<KeyspaceStats> = isShape({
  workers: isCount,
  partitions: isCount,
  entries: isCount,
  hits_total: isCount,
  misses_total: isCount,
  evictions_total: isCount,
  sets_total: isCount,
  tombstones_total: isCount,
  rehashes_total: isCount,
  arena_used_bytes: isCount,
  arena_capacity_bytes: isCount,
  hit_pct: isNullableCount,
})

const isRowCacheDatabase: Guard<RowCacheDatabase> = isShape({
  database: isString,
  state: isString,
  registrations: isCount,
  coherent: isBoolean,
  slot_lost: isBoolean,
  beat_age_ms: isNullableCount,
  stale_after_ms: isCount,
  worker_pid: isNullableCount,
})

/**
 * The row-cache body, as the auth server's `rowCacheStatus` struct writes it. Only `state` is set
 * when the row cache is unavailable or off, so every other key reads as its Go zero value there.
 */
const isRowCacheStatus: Guard<RowCacheStatus> = isShape({
  state: isOneOf(["unavailable", "off", "idle", "participating", "incoherent"] as const),
  decode_enabled: isBoolean,
  database: optional(isString),
  stale_after_ms: isCount,
  coherent: isBoolean,
  slot_lost: isBoolean,
  beat_age_ms: isNullableCount,
  registrations: isCount,
  registrations_loaded: isBoolean,
  entries: isCount,
  hits_total: isCount,
  misses_total: isCount,
  arena_used_bytes: isCount,
  arena_capacity_bytes: isCount,
  hit_pct: isNullableCount,
  participating_databases: isCount,
  incoherent_databases: isCount,
  databases: optional(isArrayOf(isRowCacheDatabase)),
})

/** One statistics endpoint's body, or null when this server has none to give. */
async function readStats<T>(client: SupatypeClient, path: string, guard: Guard<T>): Promise<T | null> {
  const r = await fetch(`${client.url}/admin/v1/${path}`, {
    headers: studioAuthHeaders(client),
    credentials: "include",
  })
  // 404: a server without these routes. 503: a deployment with no database behind them.
  // Both mean "no numbers", which the panels render as a state of their own.
  if (r.status === 404 || r.status === 503) return null
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return readJson(r, guard)
}

/**
 * Polls the two statistics endpoints and turns their cumulative counters into a rate.
 *
 * The polling is not for liveness, it is what makes the numbers mean anything: hits and misses
 * count since the segment started and are not reset by reading, so a hit rate can only be computed
 * from a delta between two reads. One sample is not enough, which is why the first render shows a
 * dash where the rate goes rather than a number, and why that is correct rather than a loading
 * state that forgot to finish.
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

    const tick = async (): Promise<void> => {
      try {
        const [ks, rc] = await Promise.all([
          readStats(client, "cache/keyspace", isKeyspaceStats),
          readStats(client, "cache/rowcache", isRowCacheStatus),
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
