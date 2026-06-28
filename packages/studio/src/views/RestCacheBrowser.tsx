import React, { useCallback, useState } from "react"
import { useStudioClient } from "../StudioCore.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useServerRestCacheOffered } from "../hooks/useServerRestCacheOffered.js"
import { Button, Card } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { SlidePanel } from "../components/SlidePanel.js"
import { cn } from "../lib/utils.js"

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

export function RestCacheBrowser({
  tableFilter,
  title = "REST Cache",
  description = "Valkey-backed GET response cache. Entries appear when a client uses .cache({ server: true }) on an allowlisted table.",
  showTableSettings = false,
}: RestCacheBrowserProps): React.ReactElement {
  const client = useStudioClient()
  const serverCacheOffered = useServerRestCacheOffered()
  const [cursor, setCursor] = useState("0")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<RestCacheDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tableCfg, setTableCfg] = useState<RestTableCacheConfig>({ enabled: false, allow_public: false })
  const [cacheMaxTTL, setCacheMaxTTL] = useState(0)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const listUrl = (() => {
    const params = new URLSearchParams({ limit: "50", cursor })
    if (tableFilter) params.set("table", tableFilter)
    return `${client.url}/admin/v1/cache?${params}`
  })()

  const { data, loading, error, refetch } = useApiQuery(
    () =>
      fetch(listUrl, { headers: studioAuthHeaders(client), credentials: "include" }).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<{ entries: RestCacheEntry[]; cursor: string }>
      }),
    [client, listUrl],
  )

  const loadSettings = useCallback(async () => {
    if (!showTableSettings || !tableFilter) return
    const r = await fetch(`${client.url}/admin/v1/config/rest`, {
      headers: studioAuthHeaders(client),
      credentials: "include",
    })
    if (!r.ok) return
    const json = (await r.json()) as {
      cache_max_ttl?: number
      cache_tables?: Record<string, RestTableCacheConfig>
    }
    setCacheMaxTTL(json.cache_max_ttl ?? 0)
    const tc = json.cache_tables?.[tableFilter]
    setTableCfg(tc ?? { enabled: false, allow_public: false })
  }, [client, showTableSettings, tableFilter])

  React.useEffect(() => {
    void loadSettings()
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
      setDetail((await r.json()) as RestCacheDetail)
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
    if (!window.confirm(tableFilter ? `Flush all cache entries for ${tableFilter}?` : "Flush all REST cache entries?")) {
      return
    }
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
      const current = (await cfgRes.json()) as {
        schema: string
        max_rows: number
        cache_max_ttl?: number
        cache_tables?: Record<string, RestTableCacheConfig>
      }
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
      await loadSettings()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSettingsSaving(false)
    }
  }

  const entries = data?.entries ?? []

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
              Free projects do <strong className="font-medium text-foreground">not</strong> get Valkey-backed
              caching. There is no in-memory cache on the server either — every API request is proxied to PostgREST,
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
              Upgrade to Pro for shared Valkey cache, per-table allowlists, and cache management in Studio.
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
          <Button size="xs" variant="secondary" onClick={() => void flushTable()}>Flush</Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {actionError && <ErrorBanner message={actionError} />}

      {showTableSettings && tableFilter && (
        <Card>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Cache settings — {tableFilter}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Server cache is off by default. Enable here, then use{" "}
              <code className="font-mono">.cache(&#123; ttl, server: true &#125;)</code> in your app.
            </p>
          </div>
          <div className="divide-y divide-border px-4 py-2 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tableCfg.enabled}
                onChange={(e) => setTableCfg((c) => ({ ...c, enabled: e.target.checked }))}
              />
              Enable server cache for this table
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tableCfg.allow_public}
                disabled={!tableCfg.enabled}
                onChange={(e) => setTableCfg((c) => ({ ...c, allow_public: e.target.checked }))}
              />
              Allow <code className="font-mono text-xs">public</code> scope (shared across users)
            </label>
            <div className="flex items-center gap-2 text-sm pt-1">
              <span className="text-muted-foreground">Max TTL (seconds)</span>
              <input
                className="w-24 rounded border border-border bg-background px-2 py-1 text-sm font-mono"
                type="number"
                min={0}
                value={cacheMaxTTL}
                onChange={(e) => setCacheMaxTTL(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <Button size="xs" variant="primary" disabled={settingsSaving} onClick={() => void saveTableSettings()}>
              {settingsSaving ? "Saving…" : "Save cache settings"}
            </Button>
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
          description={
            tableFilter
              ? `No cached responses for ${tableFilter}. Enable caching in settings above and issue a cached GET.`
              : "No cached REST responses yet."
          }
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
                  <td className="px-4 py-2 font-mono text-xs">{e.table ?? "—"}</td>
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

      {data && data.cursor !== "0" && (
        <Button size="xs" variant="secondary" onClick={() => setCursor(data.cursor)}>
          Load more
        </Button>
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
