import { useEffect, useRef } from "react"

/** Whether the tab is in the background, where nobody is reading what a poll would fetch. */
export function tabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

/**
 * Calls `tick` every `ms` while the tab is visible; `null` stops it.
 *
 * The one timer Studio's polling views share. Each had its own `setInterval` and only one of them
 * skipped a hidden tab, so the rest kept asking the server for screens nobody was looking at.
 * `tick` is read when the timer fires rather than when it was set, so a caller can pass a new
 * function each render without restarting the timer.
 */
export function useInterval(tick: () => void, ms: number | null): void {
  const latest = useRef(tick)
  latest.current = tick
  useEffect(() => {
    if (ms === null) return
    const id = setInterval(() => {
      if (!tabHidden()) latest.current()
    }, ms)
    return () => clearInterval(id)
  }, [ms])
}

/** Calls `onReturn` when the window regains focus or the tab becomes visible again. */
export function useOnReturn(onReturn: () => void): void {
  const latest = useRef(onReturn)
  latest.current = onReturn
  useEffect(() => {
    const returned = (): void => latest.current()
    const shown = (): void => {
      if (document.visibilityState === "visible") latest.current()
    }
    window.addEventListener("focus", returned)
    document.addEventListener("visibilitychange", shown)
    return () => {
      window.removeEventListener("focus", returned)
      document.removeEventListener("visibilitychange", shown)
    }
  }, [])
}
