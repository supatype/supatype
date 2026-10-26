import { useCallback, useEffect, useRef, useState } from "react"
import { useInterval, useOnReturn } from "./useTabActivity.js"

/** The auto-refresh choices a list offers, `null` for off. Directus offers the same five. */
export const AUTO_REFRESH_CHOICES: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: "Off", ms: null },
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
]

/** How old a list may be before returning to the tab refetches it: React Query's window in Supabase Studio. */
export const FOCUS_STALE_MS = 60_000

export interface ListFreshness {
  /** Fetch now, whatever else is going on. */
  refresh: () => void
  /** The auto-refresh period, `null` when off. */
  autoRefreshMs: number | null
  setAutoRefreshMs: (ms: number | null) => void
}

export interface ListFreshnessOptions {
  /** Names the view in storage, so each list remembers its own auto-refresh choice. */
  viewKey: string
  /** True while a refetch would replace something the user is in the middle of, such as an inline edit. */
  paused?: boolean
}

const storageKey = (viewKey: string): string => `supatype.studio.autoRefresh.${viewKey}`

/** The stored choice for `viewKey`, or off when there is none, it is not a choice, or storage is unavailable. */
function readAutoRefresh(viewKey: string): number | null {
  try {
    const stored = Number(window.localStorage.getItem(storageKey(viewKey)))
    return AUTO_REFRESH_CHOICES.find((c) => c.ms === stored)?.ms ?? null
  } catch {
    return null
  }
}

function writeAutoRefresh(viewKey: string, ms: number | null): void {
  try {
    if (ms === null) window.localStorage.removeItem(storageKey(viewKey))
    else window.localStorage.setItem(storageKey(viewKey), String(ms))
  } catch {
    // A private window or blocked storage: the choice holds until the view closes.
  }
}

/** The auto-refresh choice for `viewKey`, read again when the view changes to another list. */
function useAutoRefreshChoice(viewKey: string): [number | null, (ms: number | null) => void] {
  const [choice, setChoice] = useState(() => ({ viewKey, ms: readAutoRefresh(viewKey) }))
  const ms = choice.viewKey === viewKey ? choice.ms : readAutoRefresh(viewKey)
  const set = useCallback((next: number | null) => {
    writeAutoRefresh(viewKey, next)
    setChoice({ viewKey, ms: next })
  }, [viewKey])
  return [ms, set]
}

/**
 * Keeps a list current without a live stream.
 *
 * Runs `load` whenever it changes (its inputs did), on demand, on an opt-in timer that skips a
 * hidden tab, and when the user comes back to a list older than {@link FOCUS_STALE_MS} or than the
 * timer's period. `paused` holds the automatic ones back; the Refresh button still works. Rows
 * changed elsewhere otherwise stayed invisible until the filter, sort or page changed.
 */
export function useListFreshness(load: () => Promise<void>, { viewKey, paused = false }: ListFreshnessOptions): ListFreshness {
  const lastRun = useRef(0)
  const refresh = useCallback(() => {
    lastRun.current = Date.now()
    void load()
  }, [load])
  useEffect(refresh, [refresh])
  const [autoRefreshMs, setAutoRefreshMs] = useAutoRefreshChoice(viewKey)
  useInterval(() => {
    if (!paused) refresh()
  }, autoRefreshMs)
  useOnReturn(() => {
    const staleAfter = Math.min(FOCUS_STALE_MS, autoRefreshMs ?? FOCUS_STALE_MS)
    if (!paused && Date.now() - lastRun.current >= staleAfter) refresh()
  })
  return { refresh, autoRefreshMs, setAutoRefreshMs }
}
