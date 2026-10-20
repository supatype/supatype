import React, { useCallback, useEffect, useState } from "react"
import { useStudioClient } from "../StudioCore.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useServerRestCacheOffered } from "../hooks/useServerRestCacheOffered.js"
import { useInterval } from "../hooks/useTabActivity.js"
import { Button, Card, ConfirmButton, type DestructiveQuestion } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { SlidePanel } from "../components/SlidePanel.js"
import { CacheHealthPanels } from "./CacheHealthPanels.js"
import { useCacheHealth } from "../hooks/useCacheHealth.js"
import { describeStaleness, reconcileNoteFor } from "../lib/cache-health.js"
import type { ReconcileNote, RowCacheReconcile } from "../lib/cache-health.js"
import { controlsFor, isDeclaredCache, rowCacheLine } from "../lib/cache-declaration.js"
import type { DeclaredCache } from "../lib/cache-declaration.js"
import { cn } from "../lib/utils.js"
import {
  type Guard,
  isArrayOf,
  isBoolean,
  isNumber,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  readJson,
} from "../lib/json.js"

/** One thing the schema's ceiling refused or reduced, as the admin API reports it. */
export interface CacheAdjustment {
  table: string
  reason: string
}

export interface RestTableCacheConfig {
  enabled: boolean
  allow_public: boolean
}

export interface RestCacheEntry {
  key: string
  table?: string
  scope?: string
  method?: string
  path?: string
  raw_query?: string
  ttl_seconds: number
  size_bytes: number
  cached_at?: string
}

export interface RestCacheDetail extends RestCacheEntry {
  status_code: number
  content_type?: string
  body_preview?: string
  body_json?: unknown
}

const optionalText = optional(isString)

const isRestCacheEntry: Guard<RestCacheEntry> = isShape({
  key: isString,
  table: optionalText,
  scope: optionalText,
  method: optionalText,
  path: optionalText,
  raw_query: optionalText,
  ttl_seconds: isNumber,
  size_bytes: isNumber,
  cached_at: optionalText,
})

const isRestCacheDetail: Guard<RestCacheDetail> = (value: unknown): value is RestCacheDetail =>
  isRestCacheEntry(value) &&
  isShape({
    status_code: isNumber,
    content_type: optionalText,
    body_preview: optionalText,
    body_json: optional(isUnknown),
  })(value)

const isCacheListing = isShape({ entries: isArrayOf(isRestCacheEntry), cursor: isString })

const isRestTableCacheConfig: Guard<RestTableCacheConfig> = isShape({ enabled: isBoolean, allow_public: isBoolean })

/** GET /admin/v1/config/rest. `cache_tables` is null while no table has been configured. */
const isRestConfig = isShape({
  cache_max_ttl: optional(isNumber),
  cache_tables: optional(nullable(isRecordOf(isRestTableCacheConfig))),
  declared: optional(isDeclaredCache),
})

const isRowCacheReconcile: Guard<RowCacheReconcile> = isShape({
  registered: optional(isArrayOf(isString)),
  unregistered: optional(isArrayOf(isString)),
  skipped: optional(isArrayOf(isShape({ table: isString, reason: isString }))),
  unavailable: optional(isBoolean),
  error: optionalText,
})

/** What a PATCH of the REST config reports beside the saved config. */
const isRestConfigSaved = isShape({
  row_cache: optional(isRowCacheReconcile),
  adjusted: optional(isArrayOf(isShape({ table: isString, reason: isString }))),
})

function encodeCacheKey(key: string): string {
  const bytes = new TextEncoder().encode(key)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return encodeURIComponent(b64)
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export interface RestCacheBrowserProps {
  /** Physical Postgres table name (not model name). */
  tableFilter?: string | undefined
  title?: string | undefined
  description?: string | undefined
  showTableSettings?: boolean | undefined
}

/** Matches the cache health panels beside this list, so the whole screen ages together. */
const LIST_POLL_MS = 10_000

/**
 * What an empty listing means, which depends on whether caching is on.
 *
 * One sentence used to cover both, and it opened with "Enable caching in settings above", advice
 * that is wrong for anyone who already has. Two things make this list empty on a table that is
 * correctly configured, and neither is a setting: nothing has asked for a cached response yet, and
 * entries leave when their TTL expires. An empty list is the normal resting state of a working
 * cache on a quiet table.
 *
 * The opt-in matters most. The server caches a GET only when the client asks it to, so browsing
 * the app never populates this: the TTL is min(client, project, schema), and a request that names
 * no max-age asks for zero.
 */
export function emptyCacheDescription(table: string | null | undefined, enabled: boolean): string {
  if (!table) return "No cached REST responses yet."
  if (!enabled) {
    return `Caching is off for ${table}. Switch it on in settings above, then issue a cached GET.`
  }
  return (
    `Caching is on for ${table}, and nothing is cached right now. The server caches a response ` +
    `only when the client asks it to, with \`.cache({ server: true })\`; a plain GET is not ` +
    `cached. Entries also disappear when their TTL expires, so an empty list on a quiet table is ` +
    `normal rather than a fault.`
  )
}

interface CursorPages {
  cursor: string
  page: number
  next: (cursor: string) => void
  previous: () => void
}

/**
 * The pages of a scan cursor: the cursor each page starts at, the last being the page on screen.
 * Back to the first page whenever `scope` changes, since a cursor belongs to one scan.
 */
function useCursorPages(scope: string): CursorPages {
  const [pages, setPages] = useState({ scope, cursors: ["0"] })
  const cursors = pages.scope === scope ? pages.cursors : ["0"]
  const next = useCallback((cursor: string) => {
    setPages((p) => ({ scope, cursors: [...(p.scope === scope ? p.cursors : ["0"]), cursor] }))
  }, [scope])
  const previous = useCallback(() => {
    setPages((p) => ({ scope, cursors: p.scope === scope && p.cursors.length > 1 ? p.cursors.slice(0, -1) : ["0"] }))
  }, [scope])
  return { cursor: cursors[cursors.length - 1] ?? "0", page: cursors.length - 1, next, previous }
}

/** A flush empties the cache at once, for one table or for all of them. */
function flushQuestion(table: string | undefined): DestructiveQuestion {
  return {
    title: table ? `Flush every cache entry for ${table}?` : "Flush every REST cache entry?",
    detail: <p>Every entry is deleted, and reads go to the database until the cache fills again.</p>,
    answer: "Flush cache",
  }
}

export function RestCacheBrowser({
  tableFilter,
  title = "REST Cache",
  description = "Server-side GET response cache. Entries appear when a client uses .cache({ server: true }) on an allowlisted table.",
  showTableSettings = false,
}: RestCacheBrowserProps): React.ReactElement {
  const client = useStudioClient()
  const serverCacheOffered = useServerRestCacheOffered()
  // Paged rather than appended: the list refreshes on a timer, and only the page on screen can.
  const pages = useCursorPages(tableFilter ?? "")
  const cursor = pages.cursor
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<RestCacheDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tableCfg, setTableCfg] = useState<RestTableCacheConfig>({ enabled: false, allow_public: false })
  const [cacheMaxTTL, setCacheMaxTTL] = useState(0)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [rowCacheNote, setRowCacheNote] = useState<ReconcileNote | null>(null)
  // What the schema permits, which is what decides whether each control below may be moved at
  // all. Undefined until the first read: a screen that assumed "everything" would offer controls
  // the server refuses, and one that assumed "nothing" would flash every table as undeclared.
  const [declared, setDeclared] = useState<DeclaredCache | undefined>(undefined)
  const [adjustments, setAdjustments] = useState<CacheAdjustment[]>([])

  // Only on the per-table screen, and only to read the staleness window. The
  // project-wide screen gets the panels instead, and the two never render
  // together, so this does not double the polling: it moves it.
  const tableHealth = useCacheHealth(Boolean(showTableSettings && tableFilter))

  const listUrl = (() => {
    const params = new URLSearchParams({ limit: "50", cursor })
    if (tableFilter) params.set("table", tableFilter)
    return `${client.url}/admin/v1/cache?${params}`
  })()

  const { data, loading, error, refetch } = useApiQuery(
    () =>
      fetch(listUrl, { headers: studioAuthHeaders(client), credentials: "include" }).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return readJson(r, isCacheListing)
      }),
    [client, listUrl],
  )

  // Cache entries expire on their own, so this list goes stale by sitting still.
  //
  // It was fetched once on mount and then left alone, next to health panels that poll every ten
  // seconds. Half the screen was live and the half saying "nothing is cached" was frozen at
  // whatever was true when the tab was opened. Opening the page before anything had been cached
  // left it reading "No cache entries" indefinitely, which is indistinguishable from a cache that
  // does not work, and the Refresh button is only obvious once you already suspect the list.
  //
  // Paused while a row is selected: refetching under an open detail pane is how a selection
  // changes out from under someone mid-read.
  useInterval(refetch, selectedKey === null ? LIST_POLL_MS : null)

  const loadSettings = useCallback(async () => {
    if (!showTableSettings || !tableFilter) return
    const r = await fetch(`${client.url}/admin/v1/config/rest`, {
      headers: studioAuthHeaders(client),
      credentials: "include",
    })
    if (!r.ok) return
    const json = await readJson(r, isRestConfig)
    setCacheMaxTTL(json.cache_max_ttl ?? 0)
    setDeclared(json.declared ?? {})
    const tc = json.cache_tables?.[tableFilter]
    setTableCfg(tc ?? { enabled: false, allow_public: false })
  }, [client, showTableSettings, tableFilter])

  React.useEffect(() => {
    loadSettings().catch((e: unknown) => setActionError(e instanceof Error ? e.message : "Failed to load cache settings"))
  }, [loadSettings])

  async function openDetail(key: string) {
    setSelectedKey(key)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const r = await fetch(`${client.url}/admin/v1/cache/entries/${encodeCacheKey(key)}`, {
        headers: studioAuthHeaders(client),
        credentials: "include",
      })
      if (!r.ok) throw new Error(String(r.status))
      setDetail(await readJson(r, isRestCacheDetail))
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Failed to load entry")
    } finally {
      setDetailLoading(false)
    }
  }

  async function deleteEntry(key: string) {
    setActionError(null)
    try {
      const r = await fetch(`${client.url}/admin/v1/cache/entries/${encodeCacheKey(key)}`, {
        method: "DELETE",
        headers: studioAuthHeaders(client),
        credentials: "include",
      })
      if (!r.ok) throw new Error(String(r.status))
      setSelectedKey(null)
      setDetail(null)
      refetch()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed")
    }
  }

  async function flushTable() {
    setActionError(null)
    try {
      const params = tableFilter ? `?table=${encodeURIComponent(tableFilter)}` : ""
      const r = await fetch(`${client.url}/admin/v1/cache${params}`, {
        method: "DELETE",
        headers: studioAuthHeaders(client),
        credentials: "include",
      })
      if (!r.ok) throw new Error(String(r.status))
      refetch()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Flush failed")
    }
  }

  async function saveTableSettings() {
    if (!tableFilter) return
    setSettingsSaving(true)
    setActionError(null)
    try {
      const cfgRes = await fetch(`${client.url}/admin/v1/config/rest`, {
        headers: studioAuthHeaders(client),
        credentials: "include",
      })
      if (!cfgRes.ok) throw new Error(String(cfgRes.status))
      const current = await readJson(cfgRes, isRestConfig)
      const cache_tables = { ...(current.cache_tables ?? {}) }
      cache_tables[tableFilter] = { ...tableCfg }
      const r = await fetch(`${client.url}/admin/v1/config/rest`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...studioAuthHeaders(client) },
        credentials: "include",
        body: JSON.stringify({
          cache_tables,
          cache_max_ttl: cacheMaxTTL > 0 ? cacheMaxTTL : current.cache_max_ttl,
        }),
      })
      if (!r.ok) throw new Error(String(r.status))
      // The save succeeded; what the row cache made of it comes back in the
      // same body and is a note, never an error. The response cache is already
      // live either way.
      const savedBody = await r.json().catch(() => null)
      const saved = isRestConfigSaved(savedBody) ? savedBody : {}
      setRowCacheNote(reconcileNoteFor(tableFilter, saved.row_cache))
      setAdjustments((saved.adjusted ?? []).filter((a) => a.table === tableFilter || a.table === "*"))
      await loadSettings()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSettingsSaving(false)
    }
  }

  const entries = data?.entries ?? []

  // Computed rather than stored: both are a pure function of what the last read and the last save
  // returned, and a copy in state is a copy that can go stale against them.
  const controls = controlsFor(declared, tableFilter ?? "")
  const rowCache = rowCacheLine(
    declared,
    tableFilter ?? "",
    tableHealth.rowCache,
    describeStaleness,
    tableHealth.error,
  )

  if (!serverCacheOffered) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Server-side REST caching is not available on the Cloud free tier.
          </p>
        </div>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <div className="px-4 py-6 space-y-3">
            <h2 className="text-sm font-semibold">No server-side cache on Free</h2>
            <p className="text-sm text-muted-foreground">
              Free projects do <strong className="font-medium text-foreground">not</strong> get server-side
              caching. Every API request is proxied to PostgREST,
              even when the client sends <code className="text-xs font-mono">.cache(&#123; server: true &#125;)</code>{" "}
              (the server responds with <code className="text-xs font-mono">X-Supatype-Cache-Status: BYPASS</code>).
            </p>
            <p className="text-sm text-muted-foreground">
              Your app can still use <strong className="font-medium text-foreground">client-only</strong> caching in
              the browser or Node process:{" "}
              <code className="text-xs font-mono">.cache(&#123; ttl &#125;)</code> without{" "}
              <code className="text-xs font-mono">server: true</code>.
            </p>
            <p className="text-sm text-muted-foreground">
              Upgrade to Pro for a shared server-side cache, per-table allowlists, and cache management in Studio.
            </p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="xs" variant="secondary" onClick={() => refetch()}>Refresh</Button>
          <ConfirmButton size="xs" variant="secondary" ask={flushQuestion(tableFilter)} act={() => void flushTable()}>Flush</ConfirmButton>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {actionError && <ErrorBanner message={actionError} />}

      {/*
        Only on the project-wide screen. The per-model view is filtered to one table, and every
        number these panels show is per keyspace or per database. An arena fill or a coherence
        state shown under a table's name reads as that table's, and is not.
      */}
      {!tableFilter && <CacheHealthPanels />}

      {showTableSettings && tableFilter && (
        <Card>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Cache settings, {tableFilter}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your schema decides what may be cached; this decides what is. These controls can
              narrow the declaration and never widen it.
            </p>
          </div>
          <div className="divide-y divide-border px-4 py-2 space-y-2">
            <label className={cn("flex items-center gap-2 text-sm", !controls.canEnable && "text-muted-foreground")}>
              <input
                type="checkbox"
                checked={tableCfg.enabled}
                /*
                  Disabled rather than left to fail on save. The server narrows a request it does
                  not permit and reports the adjustment, so a tick here would survive exactly until
                  the save came back and then untick itself, which teaches an operator that the
                  screen is broken rather than that their schema said no.
                */
                disabled={!controls.canEnable}
                onChange={(e) => setTableCfg((c) => ({ ...c, enabled: e.target.checked }))}
              />
              Enable server cache for this table
            </label>
            {controls.reason.enable && (
              <p className="text-xs text-muted-foreground pl-6">{controls.reason.enable}</p>
            )}
            <label
              className={cn(
                "flex items-center gap-2 text-sm",
                (!tableCfg.enabled || !controls.canAllowPublic) && "text-muted-foreground",
              )}
            >
              <input
                type="checkbox"
                checked={tableCfg.allow_public}
                disabled={!tableCfg.enabled || !controls.canAllowPublic}
                onChange={(e) => setTableCfg((c) => ({ ...c, allow_public: e.target.checked }))}
              />
              Allow <code className="font-mono text-xs">public</code> scope (shared across users)
            </label>
            {controls.reason.allowPublic && tableCfg.enabled && (
              <p className="text-xs text-muted-foreground pl-6">{controls.reason.allowPublic}</p>
            )}
            <div className="flex items-center gap-2 text-sm pt-1">
              <span className="text-muted-foreground">Max TTL (seconds)</span>
              <input
                className="w-24 rounded border border-border bg-background px-2 py-1 text-sm font-mono"
                type="number"
                min={0}
                max={controls.ttlCeiling ?? undefined}
                value={cacheMaxTTL}
                onChange={(e) => setCacheMaxTTL(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            {controls.reason.ttl && <p className="text-xs text-muted-foreground">{controls.reason.ttl}</p>}
            <Button size="xs" variant="primary" disabled={settingsSaving} onClick={() => void saveTableSettings()}>
              {settingsSaving ? "Saving…" : "Save cache settings"}
            </Button>
            {/*
              One switch, two caches. A table with no primary key gets the response cache and not
              the row cache, and this is the only place that difference is ever visible. Silence
              would leave someone believing they had turned on something they had not.

              Nothing is said when the save did exactly what was asked: a confirmation on every
              save is what teaches people to stop reading the line.
            */}
            {rowCacheNote && (
              <p
                className={cn(
                  "text-xs",
                  rowCacheNote.tone === "warn" ? "text-yellow-400" : "text-muted-foreground",
                )}
              >
                {rowCacheNote.text}
              </p>
            )}
            {/*
              What the save was refused, if anything. The server narrows before it stores, so this
              is the only account of the difference between what was asked for and what is now
              true, and the controls above are disabled precisely so it stays empty.
            */}
            {adjustments.length > 0 && (
              <ul className="text-xs text-yellow-400 space-y-0.5">
                {adjustments.map((a) => (
                  <li key={`${a.table}:${a.reason}`}>
                    {a.table === "*" ? "" : `${a.table}: `}
                    {a.reason}
                  </li>
                ))}
              </ul>
            )}
            {/*
              Mode B, which has no control here and is not going to get one (§13.3). The row cache
              is eventual with a bound rather than read-your-writes, and whether a table tolerates
              that is a design-time invariant. So this says what is happening and where to change
              it. The staleness window is read live rather than hardcoded at 200ms: it grows to the
              invalidation cycle time once participating databases outnumber the worker pool, and a
              promise that understates itself is worse than none.
            */}
            <div className="pt-1">
              <p
                className={cn(
                  "text-xs",
                  rowCache.tone === "good" && "text-muted-foreground",
                  rowCache.tone === "warn" && "text-yellow-400",
                  rowCache.tone === "neutral" && "text-muted-foreground",
                )}
              >
                <span className="font-medium text-foreground">Row cache: </span>
                {rowCache.text}
              </p>
            </div>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="No cache entries"
          description={emptyCacheDescription(tableFilter, tableCfg.enabled)}
        />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase">Table</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase">Scope</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase">Path</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase">TTL</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase">Size</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.key}
                  className="border-b border-border hover:bg-accent/40 cursor-pointer"
                  onClick={() => void openDetail(e.key)}
                >
                  <td className="px-4 py-2 font-mono text-xs">{e.table ?? "-"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        "text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded",
                        e.scope === "public" ? "bg-blue-500/15 text-blue-400" : "bg-amber-500/15 text-amber-400",
                      )}
                    >
                      {e.scope ?? "user"}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs truncate max-w-[240px]">
                    {e.path}
                    {e.raw_query ? `?${e.raw_query}` : ""}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{e.ttl_seconds}s</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{formatBytes(e.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data && (pages.page > 0 || data.cursor !== "0") && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={pages.previous} disabled={pages.page === 0}>Previous</Button>
          <Button size="sm" onClick={() => pages.next(data.cursor)} disabled={data.cursor === "0"}>Next</Button>
        </div>
      )}

      <SlidePanel
        open={selectedKey !== null}
        onClose={() => { setSelectedKey(null); setDetail(null) }}
        title="Cache entry"
      >
        {detailLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {detailError && <ErrorBanner message={detailError} />}
        {detail && (
          <div className="space-y-3 text-sm">
            <p><span className="text-muted-foreground">Key:</span> <code className="text-xs break-all">{detail.key}</code></p>
            <p><span className="text-muted-foreground">Status:</span> {detail.status_code}</p>
            <p><span className="text-muted-foreground">TTL:</span> {detail.ttl_seconds}s</p>
            {detail.body_json !== undefined ? (
              <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-80">{JSON.stringify(detail.body_json, null, 2)}</pre>
            ) : detail.body_preview ? (
              <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-80">{detail.body_preview}</pre>
            ) : null}
            <Button size="xs" variant="secondary" onClick={() => void deleteEntry(detail.key)}>Delete entry</Button>
          </div>
        )}
      </SlidePanel>
    </div>
  )
}

/** Strip schema prefix from model tableName. */
export function physicalTableName(tableName: string): string {
  const dot = tableName.lastIndexOf(".")
  return dot >= 0 ? tableName.slice(dot + 1) : tableName
}
