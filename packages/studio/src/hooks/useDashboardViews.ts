import { useState, useEffect, useCallback } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { DashboardView, DashboardBlock, Tier } from "../config.js"
import { DASHBOARD_BLOCK_TYPES, DASHBOARD_VIEW_LIMITS } from "../config.js"
import { studioRestHeaders } from "../lib/studio-auth-headers.js"
import {
  bodyMessage,
  isBoolean,
  isJsonObject,
  isOneOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  readJsonObject,
  type Guard,
} from "../lib/json.js"

// Uses PostgREST multi-schema support: Accept-Profile / Content-Profile: supatype
// Requires PostgREST config: db-schemas = "public, supatype"

function postgrestHeaders(client: SupatypeClient): Record<string, string> {
  return studioRestHeaders(client, {
    "Content-Type": "application/json",
    "Accept-Profile": "supatype",
    "Content-Profile": "supatype",
  })
}

const isDashboardBlock: Guard<DashboardBlock> = isShape({
  id: isString,
  type: isOneOf(DASHBOARD_BLOCK_TYPES),
  title: isString,
  visible: isBoolean,
  model: optional(isString),
  options: optional(isJsonObject),
})

const isDashboardViewRow = isShape({
  id: isString,
  name: isString,
  is_default: isBoolean,
  layout: isUnknown,
  created_by: nullable(isString),
  created_at: isString,
  updated_at: isString,
})

/**
 * The views in a PostgREST body, which is an array for a read and for an insert alike. A block
 * Studio no longer knows is dropped from its layout rather than costing the whole view.
 */
function viewsFrom(data: unknown): DashboardView[] {
  if (!Array.isArray(data)) return []
  return data.filter(isDashboardViewRow).map((row) => ({
    ...row,
    layout: Array.isArray(row.layout) ? row.layout.filter(isDashboardBlock) : [],
  }))
}

type PgInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> }

/** One request to the `supatype` schema. `data` is the parsed body, or null for none. */
async function pgFetch(
  client: SupatypeClient,
  path: string,
  init?: PgInit,
): Promise<{ data: unknown; error: string | null }> {
  try {
    const res = await fetch(`${client.url}/rest/v1${path}`, {
      ...init,
      headers: { ...postgrestHeaders(client), ...init?.headers },
    })
    if (!res.ok) {
      const body = await readJsonObject(res)
      return { data: null, error: bodyMessage(body) ?? res.statusText }
    }
    if (res.status === 204) return { data: null, error: null }
    return { data: await res.json(), error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "Network error" }
  }
}

export interface UseDashboardViewsResult {
  views: DashboardView[]
  activeView: DashboardView | null
  loading: boolean
  /** Whether the tier limit allows saving another view. */
  canSaveMore: boolean
  setActiveView(view: DashboardView): void
  saveView(name: string, layout: DashboardBlock[], userId?: string): Promise<DashboardView | null>
  updateView(id: string, layout: DashboardBlock[]): Promise<void>
  deleteView(id: string): Promise<void>
  setDefaultView(id: string): Promise<void>
}

export function useDashboardViews(
  client: SupatypeClient,
  tier: Tier,
): UseDashboardViewsResult {
  const [views, setViews] = useState<DashboardView[]>([])
  const [activeView, setActiveView] = useState<DashboardView | null>(null)
  const [loading, setLoading] = useState(true)

  const limit = DASHBOARD_VIEW_LIMITS[tier]
  const canSaveMore = limit === -1 || views.length < limit

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const { data } = await pgFetch(client, "/dashboard_views?order=created_at.asc")
      if (data !== null) {
        const loaded = viewsFrom(data)
        setViews(loaded)
        setActiveView(loaded.find((v) => v.is_default) ?? loaded[0] ?? null)
      }
      setLoading(false)
    })()
  }, [client])

  const saveView = useCallback(async (
    name: string,
    layout: DashboardBlock[],
    userId?: string,
  ): Promise<DashboardView | null> => {
    const isFirst = views.length === 0
    const body = {
      name,
      layout,
      is_default: isFirst,
      ...(userId !== undefined && { created_by: userId }),
    }
    const { data } = await pgFetch(client, "/dashboard_views", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    })
    // `return=representation` answers with the inserted rows, an array of one.
    const saved = viewsFrom(data)[0] ?? null
    if (saved) {
      setViews((prev) => [...prev, saved])
      if (isFirst) setActiveView(saved)
    }
    return saved
  }, [client, views.length])

  const updateView = useCallback(async (id: string, layout: DashboardBlock[]): Promise<void> => {
    await pgFetch(client, `/dashboard_views?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ layout, updated_at: new Date().toISOString() }),
    })
    setViews((prev) => prev.map((v) => v.id === id ? { ...v, layout } : v))
    setActiveView((prev) => prev?.id === id ? { ...prev, layout } : prev)
  }, [client])

  const deleteView = useCallback(async (id: string): Promise<void> => {
    await pgFetch(client, `/dashboard_views?id=eq.${id}`, { method: "DELETE" })
    setViews((prev) => {
      const next = prev.filter((v) => v.id !== id)
      if (activeView?.id === id) {
        setActiveView(next.find((v) => v.is_default) ?? next[0] ?? null)
      }
      return next
    })
  }, [client, activeView])

  const setDefaultView = useCallback(async (id: string): Promise<void> => {
    // Clear existing default then set new one
    await pgFetch(client, "/dashboard_views?is_default=eq.true", {
      method: "PATCH",
      body: JSON.stringify({ is_default: false }),
    })
    await pgFetch(client, `/dashboard_views?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_default: true }),
    })
    setViews((prev) => prev.map((v) => ({ ...v, is_default: v.id === id })))
  }, [client])

  return { views, activeView, loading, canSaveMore, setActiveView, saveView, updateView, deleteView, setDefaultView }
}
