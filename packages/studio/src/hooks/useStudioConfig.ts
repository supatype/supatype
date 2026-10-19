import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import type { StudioConfigErrorKind } from "../components/StudioConfigError.js"
import type { AdminConfig } from "../config.js"
import { normalizeAdminConfig } from "../lib/normalize-admin-config.js"
import type { StudioConfigFetch } from "../lib/studio-config-fetch.js"
import { useOnReturn } from "./useTabActivity.js"

export type StudioConfigState =
  | { phase: "loading" }
  | { phase: "ready"; config: AdminConfig }
  | { phase: "error"; kind: StudioConfigErrorKind; detail?: string }

export interface StudioConfigHandle {
  state: StudioConfigState
  /** Start over from a loading screen, as after an error. */
  retry: () => void
  /** Ask again in the background; applies only a config that differs from the one shown. */
  refresh: () => void
}

type ConfigLoader = () => Promise<StudioConfigFetch>

/** The engine opens a database connection per answer, so a burst of focus and clicks asks once. */
export const CONFIG_REFRESH_INTERVAL_MS = 2_000

function parseConfig(body: string): AdminConfig | null {
  try {
    return normalizeAdminConfig(JSON.parse(body))
  } catch {
    return null
  }
}

function settle(result: StudioConfigFetch): StudioConfigState {
  if (!result.ok) {
    return { phase: "error", kind: result.kind, ...(result.detail !== undefined && { detail: result.detail }) }
  }
  const config = parseConfig(result.body)
  return config === null ? { phase: "error", kind: "unknown", detail: "Config is not valid JSON." } : { phase: "ready", config }
}

/** Reuse each entry of `prev` that `next` repeats exactly, by name. */
function reuseByName<T extends { name: string }>(prev: readonly T[], next: T[]): T[] {
  const before = new Map(prev.map((item) => [item.name, item]))
  return next.map((item) => {
    const old = before.get(item.name)
    return old !== undefined && JSON.stringify(old) === JSON.stringify(item) ? old : item
  })
}

/**
 * Keep the identity of every model and global a push did not change.
 *
 * Views key their loads on the model object: the editor reloads its record when `model` changes,
 * which discards unsaved edits. A push that touched Speaker must not reset a form open on Room.
 */
function shareUnchanged(prev: AdminConfig, next: AdminConfig): AdminConfig {
  return { ...next, models: reuseByName(prev.models, next.models), globals: reuseByName(prev.globals, next.globals) }
}

/**
 * The admin config Studio renders from, kept in step with the schema the database has.
 *
 * Loaded once up front, then asked again whenever the window regains focus or the page becomes
 * visible, and on navigation through {@link ConfigRefreshOnNavigate}. A schema pushed while Studio
 * is open used to stay invisible to the editor until a manual reload. A background answer replaces
 * the config only when its body differs from the one shown, and a failed one is ignored: the
 * config already on screen is still the best one there is. `load` of `null` loads nothing.
 */
export function useStudioConfig(
  load: ConfigLoader | null,
  minRefreshIntervalMs = CONFIG_REFRESH_INTERVAL_MS,
): StudioConfigHandle {
  const [state, setState] = useState<StudioConfigState>({ phase: "loading" })
  const [generation, setGeneration] = useState(0)
  const shownBody = useRef<string | null>(null)
  const lastAskedAt = useRef(0)
  const inFlight = useRef(false)
  // Bumped by every initial load, so an answer to a refresh started before it is dropped.
  const epoch = useRef(0)

  useEffect(() => {
    if (load === null) return
    const mine = ++epoch.current
    shownBody.current = null
    lastAskedAt.current = Date.now()
    setState({ phase: "loading" })
    void load()
      .catch((e: unknown): StudioConfigFetch => ({ ok: false, kind: "network", detail: String(e) }))
      .then((result) => {
        if (mine !== epoch.current) return
        const next = settle(result)
        if (next.phase === "ready" && result.ok) shownBody.current = result.body
        setState(next)
      })
  }, [load, generation])

  const refresh = useCallback(() => {
    if (load === null || shownBody.current === null || inFlight.current) return
    if (Date.now() - lastAskedAt.current < minRefreshIntervalMs) return
    lastAskedAt.current = Date.now()
    inFlight.current = true
    const mine = epoch.current
    void load()
      .then((result) => {
        if (mine !== epoch.current || !result.ok || result.body === shownBody.current) return
        const next = parseConfig(result.body)
        if (next === null) return
        shownBody.current = result.body
        setState((prev) => (prev.phase === "ready" ? { phase: "ready", config: shareUnchanged(prev.config, next) } : prev))
      })
      .catch(() => {
        /* the config on screen stays; the next focus or navigation asks again */
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [load, minRefreshIntervalMs])

  useOnReturn(refresh)

  const retry = useCallback(() => setGeneration((g) => g + 1), [])
  return { state, retry, refresh }
}

/** Refresh the config on every route change, the way a hosted dashboard reflects a schema change. */
export function ConfigRefreshOnNavigate({ refresh }: { refresh: () => void }): null {
  const { pathname } = useLocation()
  useEffect(() => {
    refresh()
  }, [pathname, refresh])
  return null
}
