/**
 * The shapes `/admin/v1/cache/keyspace` and `/admin/v1/cache/rowcache` return, and the four rules
 * the views behind them impose on any UI that reads them.
 *
 * Every rule here is a bug if ignored, and three of them look like working code:
 *
 *  1. The counters are cumulative and are not reset by reading. A hit rate computed from the
 *     totals shows 94% on a cache that has been broken for an hour, because the good first hour
 *     is still in the numerator. Rates come from a delta between two samples — `hitRateOver`.
 *  2. A switched-off feature returns no rows, not zeroes. The server renders that as a state
 *     rather than a struct of zeroes, and `rowCacheHeadline` keeps "off" and "healthy and idle"
 *     apart.
 *  3. `stale_after_ms` is a promise to a user, not an ops metric. Mode B is eventual with a
 *     bound, so it is said in words next to the control that turns it on — and read live, because
 *     it grows with the number of participating databases.
 *  4. `hit_pct` is null, not 0, before the first lookup. "No traffic yet" and "0% hit rate" are
 *     different states, and a fresh cache rendering 0% looks broken.
 */

export interface KeyspaceStats {
  workers: number
  partitions: number
  entries: number
  hits_total: number
  misses_total: number
  evictions_total: number
  sets_total: number
  tombstones_total: number
  rehashes_total: number
  arena_used_bytes: number
  arena_capacity_bytes: number
  /** Null before the first lookup. Rule 4. */
  hit_pct: number | null
}

export type RowCacheState = "unavailable" | "off" | "idle" | "participating" | "incoherent"

export interface RowCacheDatabase {
  database: string
  state: string
  registrations: number
  coherent: boolean
  slot_lost: boolean
  beat_age_ms: number | null
  stale_after_ms: number
  worker_pid: number | null
}

export interface RowCacheStatus {
  state: RowCacheState
  decode_enabled: boolean
  database?: string
  stale_after_ms: number
  coherent: boolean
  slot_lost: boolean
  beat_age_ms: number | null
  registrations: number
  registrations_loaded: number
  entries: number
  hits_total: number
  misses_total: number
  arena_used_bytes: number
  arena_capacity_bytes: number
  hit_pct: number | null
  participating_databases: number
  incoherent_databases: number
  databases?: RowCacheDatabase[]
}

/** A pair of counter samples, for turning cumulative totals into a rate. */
export interface Sample {
  hits: number
  misses: number
  at: number
}

export interface WindowedRate {
  /** Null when nothing was read in the window: no traffic is not a 0% hit rate. Rules 1 and 4. */
  pct: number | null
  hits: number
  misses: number
  /** Milliseconds the window covers, so the label can say what it is a rate *of*. */
  windowMs: number
}

/**
 * The hit rate between two samples of the cumulative counters.
 *
 * Returns null for `pct` whenever it cannot honestly answer: no second sample yet, no requests in
 * the window, or counters that went backwards — which they do, legitimately, when the server
 * restarts and the segment starts again from zero. Showing 0% for any of those invents an outage.
 */
export function hitRateOver(prev: Sample | null, next: Sample): WindowedRate {
  if (!prev) return { pct: null, hits: 0, misses: 0, windowMs: 0 }
  const hits = next.hits - prev.hits
  const misses = next.misses - prev.misses
  const windowMs = Math.max(0, next.at - prev.at)
  // A restart resets the segment, so a negative delta is a new counter rather than a bad read.
  // There is no rate to report across that boundary; the next window has one.
  if (hits < 0 || misses < 0) return { pct: null, hits: 0, misses: 0, windowMs }
  const total = hits + misses
  if (total === 0) return { pct: null, hits, misses, windowMs }
  return { pct: Math.round((hits * 1000) / total) / 10, hits, misses, windowMs }
}

export interface Headline {
  label: string
  tone: "neutral" | "good" | "warn" | "bad"
  /** One sentence. What it means, not what the field is called. */
  detail: string
}

/**
 * Rule 2, in one place: five states, five different things to say.
 *
 * The one that matters is `off` versus `idle`. Both have nothing cached and nothing wrong, and
 * they are opposite answers to "should I do something": `off` means the feature is not running,
 * `idle` means it is running and waiting for a table to be registered.
 */
export function rowCacheHeadline(status: RowCacheStatus | null): Headline {
  if (!status || status.state === "unavailable") {
    return {
      label: "Unavailable",
      tone: "neutral",
      detail:
        "This database does not expose the row cache's statistics. Either pg_keyspace is not installed, " +
        "or the role reading them is not a member of pg_monitor.",
    }
  }
  switch (status.state) {
    case "off":
      return {
        label: "Off",
        tone: "neutral",
        detail: "The row cache is not running. Primary-key reads go to the heap, as they always have.",
      }
    case "idle":
      return {
        label: "Waiting for tables",
        tone: "neutral",
        detail:
          "The row cache is running but no table is registered, so nothing is cached yet. " +
          "That is the normal state until a model declares one.",
      }
    case "incoherent":
      return {
        label: status.slot_lost ? "Slot lost" : "Behind",
        tone: "bad",
        detail: status.slot_lost
          ? "The server released this database's replication slot for holding too much WAL, so an unknown " +
            "set of invalidations was never delivered. Reads have stopped using the cache — answers are " +
            "still correct, they are just no longer faster."
          : "Invalidations are arriving later than the staleness window allows, so reads have stopped using " +
            "the cache. Answers are still correct; they are no longer faster.",
      }
    default:
      return {
        label: "Serving",
        tone: "good",
        detail: `Primary-key reads on ${status.registrations} registered table${
          status.registrations === 1 ? "" : "s"
        } are served from memory and invalidated as rows change.`,
      }
  }
}

/**
 * Rule 3, in words a user can act on.
 *
 * Mode B is eventual with a bound, not read-your-writes. The number has to come from the view
 * rather than the 200ms default, because it grows to the cycle time once participating databases
 * outnumber the invalidation workers — a database waiting its turn is behind by design.
 */
export function describeStaleness(staleAfterMs: number): string {
  const window =
    staleAfterMs >= 1000
      ? `${(staleAfterMs / 1000).toFixed(staleAfterMs % 1000 === 0 ? 0 : 1)} seconds`
      : `${staleAfterMs} ms`
  return (
    `Primary-key reads may be up to ${window} behind writes made on other connections. ` +
    `Your own writes are never stale to you.`
  )
}

/** Rule 4 at the point of rendering: null is "—", zero is "0%". */
export function formatPct(pct: number | null): string {
  return pct === null ? "—" : `${pct}%`
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Fill of the arena, as a percentage, or null when there is no arena to fill. */
export function arenaFillPct(used: number, capacity: number): number | null {
  if (capacity <= 0) return null
  return Math.round((used * 1000) / capacity) / 10
}
