/**
 * Jump to's search of live data: users and every model's records, each searched on the server a
 * page at a time, with more of any group loaded on request.
 *
 * It used to read the first 200 users and filter them in the browser, search only the first five
 * models, and show at most five records of each, so whatever lay past those could not be reached.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import { isJsonObject } from "../lib/json.js"
import { recordLabel } from "../lib/localized-field.js"
import { anyFieldContains, searchColumns } from "../lib/postgrest-search.js"
import { searchAuthUsers } from "../lib/relation-auth-users.js"
import { studioRestHeaders } from "../lib/studio-auth-headers.js"

export type SearchItem = {
  label: string
  description?: string
  href: string
  category: string
  /** `more` is the row that loads the next page of `group`. */
  kind: "route" | "record" | "more"
  group?: string
}

/** Rows per page of each group, small since every group shares one dropdown. */
export const JUMP_PAGE_SIZE = 5
const SEARCH_DEBOUNCE_MS = 300

interface LivePage {
  items: SearchItem[]
  total: number
}

/** One searchable group: users, or one model's records. */
interface LiveSource {
  key: string
  label: string
  fetch: (page: number, signal?: AbortSignal) => Promise<LivePage>
}

/** A group's rows so far, how many match in all, and how many pages are loaded. */
export interface LiveGroup {
  key: string
  label: string
  items: SearchItem[]
  total: number
  pages: number
}

function userSource(client: SupatypeClient, term: string): LiveSource {
  return {
    key: "users",
    label: "users",
    fetch: async (page, signal) => {
      const { users, total } = await searchAuthUsers(client, term, { page, perPage: JUMP_PAGE_SIZE }, signal)
      const items = users.map((u): SearchItem => ({
        label: u.email || u.id,
        ...(u.name !== "" && { description: u.name }),
        href: `/authentication/users?user=${encodeURIComponent(u.id)}`,
        category: "Users",
        kind: "record",
      }))
      return { items, total }
    },
  }
}

/** PostgREST's count from Content-Range (`0-4/12`, `*\/0`); without one, one more than seen while pages come back full. */
function rangeTotal(res: Response, offset: number, rows: number): number {
  const match = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "")
  if (match) return Number(match[1])
  return offset + rows + (rows === JUMP_PAGE_SIZE ? 1 : 0)
}

function recordItem(model: ModelConfig, row: Record<string, unknown>, locales: readonly string[]): SearchItem {
  const [locale = "en"] = locales
  const label = recordLabel(row, model, locale, locale) ?? String(row[model.primaryKey] ?? "Record")
  return {
    label,
    description: model.label,
    href: `/models/${model.name}/${String(row[model.primaryKey])}`,
    category: model.label,
    kind: "record",
  }
}

/** A model's search on the server; `locales` lead with the default, which names what is found. */
function modelSource(client: SupatypeClient, model: ModelConfig, term: string, locales: readonly string[]): LiveSource {
  // With no declared search fields, the usual naming columns the model has; a guessed column it
  // lacks failed its search.
  const names = model.searchFields.length > 0
    ? model.searchFields
    : ["name", "title", "email"].filter((name) => model.fields.some((f) => f.name === name))
  const columns = searchColumns(model.fields, names, locales)
  // Quoted and escaped, so the search is read literally: it used to drop commas and parentheses
  // and read % and _ as wildcards.
  const or = `(${anyFieldContains(columns, term)})`
  return {
    key: `model:${model.name}`,
    label: model.labelPlural,
    fetch: async (page, signal) => {
      if (columns.length === 0) return { items: [], total: 0 }
      const offset = page * JUMP_PAGE_SIZE
      const params = new URLSearchParams({ or, select: "*", limit: String(JUMP_PAGE_SIZE), offset: String(offset) })
      const headers = studioRestHeaders(client, { Prefer: "count=exact" })
      const res = await fetch(`${client.url}/rest/v1/${model.tableName}?${params.toString()}`, { headers, ...(signal !== undefined && { signal }) })
      if (!res.ok) return { items: [], total: 0 }
      const body: unknown = await res.json()
      const rows = Array.isArray(body) ? body.filter(isJsonObject) : []
      return { items: rows.map((row) => recordItem(model, row, locales)), total: rangeTotal(res, offset, rows.length) }
    },
  }
}

/** A source's first page as a group; a failed source is an empty group, as the others still answer. */
async function firstGroup(source: LiveSource, signal: AbortSignal): Promise<LiveGroup> {
  const page = await source.fetch(0, signal).catch((): LivePage => ({ items: [], total: 0 }))
  return { key: source.key, label: source.label, items: page.items, total: page.total, pages: 1 }
}

function moreRow(group: LiveGroup): SearchItem {
  return {
    label: `More ${group.label} (${group.total - group.items.length} more)`,
    href: "",
    category: group.items[0]?.category ?? group.label,
    kind: "more",
    group: group.key,
  }
}

/** Every group's rows, each followed by its "More" row while the server holds more. */
export function liveRows(groups: LiveGroup[]): SearchItem[] {
  return groups.flatMap((g) => (g.items.length < g.total ? [...g.items, moreRow(g)] : g.items))
}

function appendPage(groups: LiveGroup[], key: string, next: LivePage): LiveGroup[] {
  return groups.map((g) => (g.key === key ? { ...g, items: [...g.items, ...next.items], total: next.total, pages: g.pages + 1 } : g))
}

export interface LiveSearch {
  groups: LiveGroup[]
  searching: boolean
  loadMore: (key: string) => void
}

/** The groups matching `query` once typing pauses, searched on the server. */
export function useLiveSearch(
  client: SupatypeClient,
  models: ModelConfig[],
  query: string,
  locales: readonly string[],
): LiveSearch {
  const term = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS)
  const [groups, setGroups] = useState<LiveGroup[]>([])
  const [searching, setSearching] = useState(false)
  const sourcesRef = useRef<LiveSource[]>([])
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  useEffect(() => {
    const sources = term.length < 2 ? [] : [userSource(client, term), ...models.map((m) => modelSource(client, m, term, locales))]
    sourcesRef.current = sources
    const controller = new AbortController()
    setSearching(sources.length > 0)
    void Promise.all(sources.map((s) => firstGroup(s, controller.signal))).then((found) => {
      if (controller.signal.aborted) return
      setGroups(found.filter((g) => g.items.length > 0))
      setSearching(false)
    })
    return () => controller.abort()
  }, [client, models, term, locales])

  const loadMore = useCallback((key: string) => {
    const sources = sourcesRef.current
    const source = sources.find((s) => s.key === key)
    const group = groupsRef.current.find((g) => g.key === key)
    if (!source || !group) return
    void source.fetch(group.pages).then((next) => {
      // Dropped when the search changed while this page loaded.
      if (sourcesRef.current === sources) setGroups((gs) => appendPage(gs, key, next))
    }).catch(() => { /* the rows already shown stay */ })
  }, [])

  return { groups, searching, loadMore }
}
