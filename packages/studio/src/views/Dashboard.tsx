import React, { useState, useEffect, useCallback } from "react"
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useDashboardViews } from "../hooks/useDashboardViews.js"
import type { SupatypeClient } from "@supatype/client"
import type { DashboardBlock, ModelConfig } from "../config.js"
import { DASHBOARD_VIEW_LIMITS } from "../config.js"
import { JumpToSearch } from "../components/JumpToSearch.js"
import { studioRestHeaders } from "../lib/studio-auth-headers.js"
import { type Guard, isArrayOf, isJsonObject, isNumber, isShape, isString, isUnknown, readJson } from "../lib/json.js"
import { Link } from "react-router-dom"
import { useLocale } from "../hooks/useLocale.js"
import { recordLabel } from "../lib/localized-field.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { authUserListPath, userListTotal } from "../lib/auth-user-search.js"
import { firstModelWithCreatedAt, hasCreatedAt } from "../lib/model-created-at.js"

// ─── Response bodies ──────────────────────────────────────────────────────────

/** The auth admin user list; only its length is read, the count comes from X-Total-Count. */
const isUserListBody = isShape({ users: isArrayOf(isUnknown) })

/** `storage_stats()`: `RETURNS TABLE(file_count BIGINT, total_bytes BIGINT)`, both never null. */
const isStorageStats = isArrayOf(isShape({ file_count: isNumber, total_bytes: isNumber }))

/** `db_stats()`: `RETURNS TABLE(db_size_bytes BIGINT, db_size_pretty TEXT)`. */
const isDbStats = isArrayOf(isShape({ db_size_bytes: isNumber, db_size_pretty: isString }))

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const config = useAdminConfig()
  const client = useAdminClient()
  const tier = config.tier ?? "free"

  const { views, activeView, loading, canSaveMore, setActiveView, saveView, updateView, setDefaultView, deleteView } =
    useDashboardViews(client, tier)

  const [editMode, setEditMode] = useState(false)
  const [draftLayout, setDraftLayout] = useState<DashboardBlock[]>([])
  const [savePrompt, setSavePrompt] = useState(false)
  const [saveName, setSaveName] = useState("")

  // When active view changes (or first load with no saved views), sync draft layout
  useEffect(() => {
    if (activeView) {
      setDraftLayout(normalizeLayout(activeView.layout, config.models))
    } else if (!loading) {
      setDraftLayout(generateDefaultBlocks(config.models))
    }
  }, [activeView, loading, config.models])

  const toggleBlock = useCallback((id: string) => {
    setDraftLayout((prev) => prev.map((b) => b.id === id ? { ...b, visible: !b.visible } : b))
  }, [])

  const handleSave = useCallback(async () => {
    if (!saveName.trim()) return
    if (activeView) {
      await updateView(activeView.id, draftLayout)
    } else {
      await saveView(saveName.trim(), draftLayout)
    }
    setSavePrompt(false)
    setSaveName("")
    setEditMode(false)
  }, [activeView, draftLayout, saveName, saveView, updateView])

  const handleSaveAs = useCallback(async () => {
    if (!saveName.trim()) return
    await saveView(saveName.trim(), draftLayout)
    setSavePrompt(false)
    setSaveName("")
    setEditMode(false)
  }, [draftLayout, saveName, saveView])

  const safeDraftLayout = normalizeLayout(draftLayout, config.models)
  const visibleBlocks = editMode ? safeDraftLayout : safeDraftLayout.filter((b) => b.visible)
  const limit = DASHBOARD_VIEW_LIMITS[tier]
  const limitLabel = limit === -1 ? "Unlimited" : String(limit)

  return (
    <div className="space-y-4">
      {/* Jump-to search */}
      <JumpToSearch />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {views.length > 0 && (
            <select
              className="text-sm rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={activeView?.id ?? ""}
              onChange={(e) => {
                const v = views.find((x) => x.id === e.target.value)
                if (v) setActiveView(v)
              }}
            >
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          )}
          {activeView && !activeView.is_default && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => void setDefaultView(activeView.id)}
            >
              Set as default
            </button>
          )}
          {activeView && views.length > 1 && (
            <button
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
              onClick={() => void deleteView(activeView.id)}
            >
              Delete
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {editMode && (
            <>
              {savePrompt ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    className="text-sm rounded-md border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring w-44"
                    placeholder="View name…"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleSave() }}
                  />
                  <button
                    className="text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    onClick={() => void handleSave()}
                  >
                    Save
                  </button>
                  {activeView && canSaveMore && (
                    <button
                      className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
                      onClick={() => void handleSaveAs()}
                    >
                      Save as new
                    </button>
                  )}
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => { setSavePrompt(false); setSaveName("") }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="text-sm px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => { setSaveName(activeView?.name ?? ""); setSavePrompt(true) }}
                  >
                    {activeView ? "Save changes" : "Save view"}
                  </button>
                  {!canSaveMore && !activeView && (
                    <span className="text-xs text-muted-foreground">
                      {limitLabel} view limit reached, upgrade to save more
                    </span>
                  )}
                  <button
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => {
                      setDraftLayout(activeView?.layout ?? generateDefaultBlocks(config.models))
                      setEditMode(false)
                    }}
                  >
                    Cancel
                  </button>
                </>
              )}
            </>
          )}
          {!editMode && (
            <button
              className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
              onClick={() => setEditMode(true)}
            >
              Edit dashboard
            </button>
          )}
        </div>
      </div>

      {/* Edit mode hint */}
      {editMode && (
        <p className="text-xs text-muted-foreground">
          Click the eye icon to show or hide blocks. Changes are not saved until you click "Save view".
        </p>
      )}

      {/* Block grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5 animate-pulse h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(editMode ? safeDraftLayout : visibleBlocks).map((block, index) => (
            <DashboardBlockCard
              key={`${block.id}-${index}`}
              block={block}
              editMode={editMode}
              onToggle={toggleBlock}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Block card ───────────────────────────────────────────────────────────────

function DashboardBlockCard({
  block,
  editMode,
  onToggle,
}: {
  block: DashboardBlock
  editMode: boolean
  onToggle(id: string): void
}): React.ReactElement {
  const hidden = !block.visible

  return (
    <div className={`relative rounded-lg border bg-card transition-opacity ${hidden ? "opacity-40 border-dashed border-border" : "border-border"}`}>
      {editMode && (
        <button
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors z-10"
          title={hidden ? "Show block" : "Hide block"}
          onClick={() => onToggle(block.id)}
        >
          {hidden ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
      <div className={editMode ? "pr-8" : ""}>
        <BlockContent block={block} />
      </div>
    </div>
  )
}

function BlockContent({ block }: { block: DashboardBlock }): React.ReactElement {
  switch (block.type) {
    case "stats":          return <StatsBlock block={block} />
    case "recent":         return <RecentBlock block={block} />
    case "auth":           return <AuthBlock />
    case "storage":        return <StorageBlock />
    case "quick-actions":  return <QuickActionsBlock />
    case "signups-chart":  return <SignupsChartBlock />
    case "db-size":        return <DbSizeBlock />
    case "content-chart":  return <ContentChartBlock block={block} />
    default:
      return (
        <div className="p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">{block.title}</h3>
          <p className="text-sm text-muted-foreground">Coming soon</p>
        </div>
      )
  }
}

// ─── Stats block ──────────────────────────────────────────────────────────────

/** How many rows a PostgREST HEAD request counts, from its Content-Range; no rows are sent. */
async function headCount(url: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, { method: "HEAD", headers })
  return parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0", 10)
}

function StatsBlock({ block }: { block: DashboardBlock }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const [count, setCount] = useState<number | null>(null)
  const [trend, setTrend] = useState<number | null>(null)
  // The week's count reads created_at, which only some models have.
  const dated = hasCreatedAt(config.models, block.model)

  useEffect(() => {
    if (!block.model) return
    void (async () => {
      try {
        const url = `${client.url}/rest/v1/${block.model}?select=id`
        const headers = studioRestHeaders(client, { Prefer: "count=exact" })
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
        const [total, week] = await Promise.all([
          headCount(url, headers),
          dated ? headCount(`${url}&created_at=gte.${weekAgo}`, headers) : Promise.resolve(null),
        ])
        setCount(total)
        setTrend(week)
      } catch {
        setCount(0)
      }
    })()
  }, [client, block.model, dated])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{block.title}</h3>
      <div className="text-3xl font-bold text-foreground">{count ?? "…"}</div>
      {trend !== null && trend > 0 && (
        <p className="text-xs text-emerald-500 mt-1">+{trend} this week</p>
      )}
    </div>
  )
}

// ─── Recent block ─────────────────────────────────────────────────────────────

export function RecentBlock({ block }: { block: DashboardBlock }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const { currentLocale, defaultLocale } = useLocale()
  const [items, setItems] = useState<Record<string, unknown>[]>([])

  const modelConfig = config.models.find((m) => m.tableName === block.model)
  const dated = hasCreatedAt(config.models, block.model)

  useEffect(() => {
    const model = block.model
    if (!model) return
    void (async () => {
      try {
        const query = client.from(model).select()
        // Newest first where the model records when a row was made; asking for created_at elsewhere answers 400.
        const result = await (dated ? query.order("created_at", { ascending: false }) : query).limit(5)
        const rows: unknown = result.data
        if (Array.isArray(rows)) setItems(rows.filter(isJsonObject))
      } catch {
        setItems([])
      }
    })()
  }, [client, block.model, dated])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{block.title}</h3>
      <ul className="space-y-1">
        {items.map((item, i) => {
          // A localized title is a JSON object; `String()` of it read "[object Object]".
          const label = recordLabel(item, modelConfig, currentLocale, defaultLocale) ?? String(item["id"] ?? `Item ${i + 1}`)
          const href = modelConfig ? `/models/${modelConfig.name}/${String(item[modelConfig.primaryKey])}` : undefined
          return (
            <li key={i} className="py-1.5 border-b border-border last:border-0 text-sm text-foreground">
              {href ? (
                // A router link: a plain href left out Studio's base path and opened the app instead.
                <Link to={href} className="hover:text-primary transition-colors truncate block">{label}</Link>
              ) : (
                <span className="truncate block">{label}</span>
              )}
            </li>
          )
        })}
        {items.length === 0 && (
          <li className="text-sm text-muted-foreground">
            {modelConfig ? (
              <Link to={`/models/${modelConfig.name}/create`} className="hover:text-primary transition-colors">
                Create your first {modelConfig.label} →
              </Link>
            ) : "No items yet"}
          </li>
        )}
      </ul>
    </div>
  )
}

// ─── Auth block ───────────────────────────────────────────────────────────────

/**
 * How many users the project has: the server's X-Total-Count for a one-row page. Counting the rows
 * of a page capped the figure at the page size.
 */
async function fetchUserTotal(client: SupatypeClient): Promise<number | null> {
  const at = { filter: "", page: 0, perPage: 1 }
  const res = await fetch(`${client.url}/auth/v1/admin${authUserListPath(at)}`, { headers: studioRestHeaders(client) })
  if (!res.ok) return null
  return userListTotal(res, at, (await readJson(res, isUserListBody)).users.length)
}

/** Sign-ups over the last seven days, from the same function the sign-ups chart reads. */
async function fetchSignupsThisWeek(client: SupatypeClient): Promise<number | null> {
  const res = await fetch(`${client.url}/rest/v1/rpc/daily_signups?days=7`, {
    headers: studioRestHeaders(client, { "Accept-Profile": "supatype" }),
  })
  if (!res.ok) return null
  return (await readJson(res, isDailyRows)).reduce((sum, row) => sum + row.count, 0)
}

export function AuthBlock(): React.ReactElement {
  const client = useAdminClient()
  const [total, setTotal] = useState<number | null>(null)
  const [newThisWeek, setNewThisWeek] = useState<number | null>(null)

  useEffect(() => {
    void fetchUserTotal(client).then((n) => setTotal(n ?? 0), () => setTotal(0))
    void fetchSignupsThisWeek(client).then(setNewThisWeek, () => setNewThisWeek(null))
  }, [client])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Total Users</h3>
      <div className="text-3xl font-bold text-foreground">{total ?? "…"}</div>
      {newThisWeek !== null && newThisWeek > 0 && (
        <p className="text-xs text-emerald-500 mt-1">+{newThisWeek} this week</p>
      )}
    </div>
  )
}

// ─── Storage block ────────────────────────────────────────────────────────────

function StorageBlock(): React.ReactElement {
  const client = useAdminClient()
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)
  const [fileCount, setFileCount] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${client.url}/rest/v1/rpc/storage_stats`, {
          method: "POST",
          headers: studioRestHeaders(client, {
            "Content-Profile": "supatype",
            "Accept-Profile": "supatype",
            "Content-Type": "application/json",
          }),
          body: "{}",
        })
        if (res.ok) {
          const rows = await readJson(res, isStorageStats)
          if (rows[0]) { setFileCount(rows[0].file_count); setSizeBytes(rows[0].total_bytes) }
        }
      } catch {
        setSizeBytes(0)
        setFileCount(0)
      }
    })()
  }, [client])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Storage Used</h3>
      <div className="text-3xl font-bold text-foreground">
        {sizeBytes === null ? "…" : formatBytes(sizeBytes)}
      </div>
      {fileCount !== null && (
        <p className="text-xs text-muted-foreground mt-1">{fileCount.toLocaleString()} files</p>
      )}
    </div>
  )
}

// ─── Quick actions block ──────────────────────────────────────────────────────

function QuickActionsBlock(): React.ReactElement {
  const config = useAdminConfig()

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</h3>
      <div className="flex flex-wrap gap-2">
        {config.globals.map((g) => (
          <Link
            key={g.name}
            to={`/models/globals/${g.name}`}
            className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
          >
            {g.label}
          </Link>
        ))}
        {config.models.slice(0, 4).map((m) => (
          <Link
            key={m.name}
            to={`/models/${m.name}/create`}
            className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
          >
            + {m.label}
          </Link>
        ))}
      </div>
    </div>
  )
}

// ─── Signups chart ────────────────────────────────────────────────────────────

type DailyRow = { day: string; count: number }

/** `daily_signups` and `daily_content_creates`: `RETURNS TABLE(day DATE, count INT)`. */
const isDailyRows: Guard<DailyRow[]> = isArrayOf(isShape({ day: isString, count: isNumber }))

function SignupsChartBlock(): React.ReactElement {
  const client = useAdminClient()
  const [data, setData] = useState<DailyRow[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `${client.url}/rest/v1/rpc/daily_signups?days=30`,
          { headers: studioRestHeaders(client, { "Accept-Profile": "supatype" }) },
        )
        if (res.ok) setData(await readJson(res, isDailyRows))
      } catch { /* leave empty */ }
    })()
  }, [client])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
        New Signups: last 30 days
      </h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No signup data yet</p>
      ) : (
        <ChartContainer config={{ count: { label: "Signups", color: "hsl(262 80% 60%)" } }} className="h-36">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="signupsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v: string) => v.slice(5)} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => `${l}`} />} />
            <Area dataKey="count" stroke="var(--color-count)" fill="url(#signupsFill)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  )
}

// ─── DB size block ────────────────────────────────────────────────────────────

function DbSizeBlock(): React.ReactElement {
  const client = useAdminClient()
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)
  const [sizePretty, setSizePretty] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `${client.url}/rest/v1/rpc/db_stats`,
          {
            method: "POST",
            headers: studioRestHeaders(client, {
              "Content-Profile": "supatype",
              "Accept-Profile": "supatype",
              "Content-Type": "application/json",
            }),
            body: "{}",
          },
        )
        if (res.ok) {
          const rows = await readJson(res, isDbStats)
          if (rows[0]) { setSizeBytes(rows[0].db_size_bytes); setSizePretty(rows[0].db_size_pretty) }
        }
      } catch { /* leave empty */ }
    })()
  }, [client])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Database Size</h3>
      <div className="text-3xl font-bold text-foreground">{sizePretty ?? (sizeBytes !== null ? formatBytes(sizeBytes) : "…")}</div>
      <p className="text-xs text-muted-foreground mt-1">Total on-disk size including indexes</p>
    </div>
  )
}

// ─── Content chart block ──────────────────────────────────────────────────────

function ContentChartBlock({ block }: { block: DashboardBlock }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const [data, setData] = useState<DailyRow[]>([])

  // Rows per day by created_at, so only a model that has one: a stored layout may name one that does not.
  const model = block.model ?? firstModelWithCreatedAt(config.models)?.tableName
  const charted = hasCreatedAt(config.models, model)

  useEffect(() => {
    if (!model || !charted) return
    void (async () => {
      try {
        const res = await fetch(
          `${client.url}/rest/v1/rpc/daily_content_creates`,
          {
            method: "POST",
            headers: studioRestHeaders(client, {
              "Content-Profile": "supatype",
              "Accept-Profile": "supatype",
              "Content-Type": "application/json",
            }),
            body: JSON.stringify({ table_name: model, days: 30 }),
          },
        )
        if (res.ok) setData(await readJson(res, isDailyRows))
      } catch { /* leave empty */ }
    })()
  }, [client, model, charted])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
        {block.title}
      </h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data yet</p>
      ) : (
        <ChartContainer config={{ count: { label: "Created", color: "hsl(142 70% 50%)" } }} className="h-36">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v: string) => v.slice(5)} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => `${l}`} />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartContainer>
      )}
    </div>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function EyeIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function generateDefaultBlocks(models: ModelConfig[]): DashboardBlock[] {
  const charted = firstModelWithCreatedAt(models)
  const blocks: DashboardBlock[] = [
    { id: "block-quick-actions",   type: "quick-actions",  title: "Quick Actions",             visible: true },
    { id: "block-auth-users",      type: "auth",           title: "Total Users",               visible: true },
    { id: "block-storage",         type: "storage",        title: "Storage",                   visible: true },
    { id: "block-signups-chart",   type: "signups-chart",  title: "New Signups",               visible: true },
    { id: "block-db-size",         type: "db-size",        title: "Database Size",             visible: true },
    ...(charted ? [{ id: `block-content-chart-${charted.tableName}`, type: "content-chart" as const, title: `${charted.labelPlural} Created`, visible: true, model: charted.tableName }] : []),
  ]
  for (const m of models.slice(0, 3)) {
    blocks.push({ id: `block-stats-${m.tableName}`,  type: "stats",  title: `Total ${m.labelPlural}`,  visible: true, model: m.tableName })
    blocks.push({ id: `block-recent-${m.tableName}`, type: "recent", title: `Recent ${m.labelPlural}`, visible: true, model: m.tableName })
  }
  return blocks
}

function normalizeLayout(layout: unknown, models: ModelConfig[]): DashboardBlock[] {
  if (!Array.isArray(layout)) return generateDefaultBlocks(models)
  const modelNames = new Set(models.map((m) => m.tableName))
  const result: DashboardBlock[] = []

  for (let i = 0; i < layout.length; i += 1) {
    const item: unknown = layout[i]
    if (!item || typeof item !== "object") continue

    const candidate = item as Partial<DashboardBlock>
    const fallbackType: DashboardBlock["type"] = "custom"
    const type = typeof candidate.type === "string"
      ? candidate.type as DashboardBlock["type"]
      : fallbackType
    const title = typeof candidate.title === "string" && candidate.title.length > 0
      ? candidate.title
      : "Untitled Block"
    const visible = typeof candidate.visible === "boolean" ? candidate.visible : true
    const id = typeof candidate.id === "string" && candidate.id.length > 0
      ? candidate.id
      : `block-${type}-${i}`
    const model = typeof candidate.model === "string" && modelNames.has(candidate.model)
      ? candidate.model
      : undefined

    result.push({
      id,
      type,
      title,
      visible,
      ...(model !== undefined && { model }),
    })
  }

  return result.length > 0 ? result : generateDefaultBlocks(models)
}
