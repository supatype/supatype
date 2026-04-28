import React, { useState, useEffect, useCallback } from "react"
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useDashboardViews } from "../hooks/useDashboardViews.js"
import type { DashboardBlock, ModelConfig } from "../config.js"
import { DASHBOARD_VIEW_LIMITS } from "../config.js"
import { JumpToSearch } from "../components/JumpToSearch.js"

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
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
      setDraftLayout(activeView.layout)
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

  const visibleBlocks = editMode ? draftLayout : draftLayout.filter((b) => b.visible)
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
                      {limitLabel} view limit reached — upgrade to save more
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
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5 animate-pulse h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(editMode ? draftLayout : visibleBlocks).map((block) => (
            <DashboardBlockCard
              key={block.id}
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

function StatsBlock({ block }: { block: DashboardBlock }): React.ReactElement {
  const client = useAdminClient()
  const [count, setCount] = useState<number | null>(null)
  const [trend, setTrend] = useState<number | null>(null)

  useEffect(() => {
    if (!block.model) return
    void (async () => {
      try {
        // Count via PostgREST head request (no data transferred)
        const url = `${client.url}/rest/v1/${block.model}?select=id`
        const key = client.serviceRoleKey ?? ""
        const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" }

        const [totalRes, weekRes] = await Promise.all([
          fetch(url, { method: "HEAD", headers }),
          fetch(
            `${url}&created_at=gte.${new Date(Date.now() - 7 * 86_400_000).toISOString()}`,
            { method: "HEAD", headers },
          ),
        ])

        const total = parseInt(totalRes.headers.get("content-range")?.split("/")[1] ?? "0", 10)
        const week = parseInt(weekRes.headers.get("content-range")?.split("/")[1] ?? "0", 10)
        setCount(total)
        setTrend(week)
      } catch {
        setCount(0)
      }
    })()
  }, [client, block.model])

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

function RecentBlock({ block }: { block: DashboardBlock }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const [items, setItems] = useState<Record<string, unknown>[]>([])

  const modelConfig = config.models.find((m) => m.tableName === block.model)

  useEffect(() => {
    if (!block.model) return
    void (async () => {
      try {
        const result = await client
          .from(block.model as never)
          .select()
          .order("created_at", { ascending: false })
          .limit(5)
        if (result.data) setItems(result.data as Record<string, unknown>[])
      } catch {
        setItems([])
      }
    })()
  }, [client, block.model])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">{block.title}</h3>
      <ul className="space-y-1">
        {items.map((item, i) => {
          const label = String(item["name"] ?? item["title"] ?? item["id"] ?? `Item ${i + 1}`)
          const href = modelConfig ? `/models/${modelConfig.name}/${String(item[modelConfig.primaryKey])}` : undefined
          return (
            <li key={i} className="py-1.5 border-b border-border last:border-0 text-sm text-foreground">
              {href ? (
                <a href={href} className="hover:text-primary transition-colors truncate block">{label}</a>
              ) : (
                <span className="truncate block">{label}</span>
              )}
            </li>
          )
        })}
        {items.length === 0 && (
          <li className="text-sm text-muted-foreground">
            {modelConfig ? (
              <a href={`/${modelConfig.name}/new`} className="hover:text-primary transition-colors">
                Create your first {modelConfig.label} →
              </a>
            ) : "No items yet"}
          </li>
        )}
      </ul>
    </div>
  )
}

// ─── Auth block ───────────────────────────────────────────────────────────────

function AuthBlock(): React.ReactElement {
  const client = useAdminClient()
  const [total, setTotal] = useState<number | null>(null)
  const [newThisWeek, setNewThisWeek] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const key = client.serviceRoleKey ?? ""
        const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" }
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

        const [totalRes, weekRes] = await Promise.all([
          fetch(`${client.url}/auth/v1/admin/users`, { headers }),
          fetch(`${client.url}/auth/v1/admin/users?created_after=${weekAgo}`, { headers }),
        ])

        if (totalRes.ok) {
          const data = await totalRes.json() as { total?: number; users?: unknown[] }
          setTotal(data.total ?? (Array.isArray(data.users) ? data.users.length : 0))
        }
        if (weekRes.ok) {
          const data = await weekRes.json() as { total?: number; users?: unknown[] }
          setNewThisWeek(data.total ?? (Array.isArray(data.users) ? data.users.length : 0))
        }
      } catch {
        setTotal(0)
      }
    })()
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
        const key = client.serviceRoleKey ?? ""
        const res = await fetch(`${client.url}/rest/v1/rpc/storage_stats`, {
          method: "POST",
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Profile": "supatype", "Accept-Profile": "supatype", "Content-Type": "application/json" },
          body: "{}",
        })
        if (res.ok) {
          const rows = await res.json() as Array<{ file_count: number; total_bytes: number }>
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
        {config.models.slice(0, 4).map((m) => (
          <a
            key={m.name}
            href={`/models/${m.name}/create`}
            className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
          >
            + {m.label}
          </a>
        ))}
      </div>
    </div>
  )
}

// ─── Signups chart ────────────────────────────────────────────────────────────

type DailyRow = { day: string; count: number }

function SignupsChartBlock(): React.ReactElement {
  const client = useAdminClient()
  const [data, setData] = useState<DailyRow[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const key = client.serviceRoleKey ?? ""
        const res = await fetch(
          `${client.url}/rest/v1/rpc/daily_signups?days=30`,
          { headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "supatype" } },
        )
        if (res.ok) setData((await res.json()) as DailyRow[])
      } catch { /* leave empty */ }
    })()
  }, [client])

  return (
    <div className="p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
        New Signups — last 30 days
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
        const key = client.serviceRoleKey ?? ""
        const res = await fetch(
          `${client.url}/rest/v1/rpc/db_stats`,
          { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Profile": "supatype", "Accept-Profile": "supatype", "Content-Type": "application/json" }, body: "{}" },
        )
        if (res.ok) {
          const rows = await res.json() as Array<{ db_size_bytes: number; db_size_pretty: string }>
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

  const model = block.model ?? config.models[0]?.tableName

  useEffect(() => {
    if (!model) return
    void (async () => {
      try {
        const key = client.serviceRoleKey ?? ""
        const res = await fetch(
          `${client.url}/rest/v1/rpc/daily_content_creates`,
          {
            method: "POST",
            headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Profile": "supatype", "Accept-Profile": "supatype", "Content-Type": "application/json" },
            body: JSON.stringify({ table_name: model, days: 30 }),
          },
        )
        if (res.ok) setData((await res.json()) as DailyRow[])
      } catch { /* leave empty */ }
    })()
  }, [client, model])

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
  const blocks: DashboardBlock[] = [
    { id: "block-quick-actions",   type: "quick-actions",  title: "Quick Actions",             visible: true },
    { id: "block-auth-users",      type: "auth",           title: "Total Users",               visible: true },
    { id: "block-storage",         type: "storage",        title: "Storage",                   visible: true },
    { id: "block-signups-chart",   type: "signups-chart",  title: "New Signups",               visible: true },
    { id: "block-db-size",         type: "db-size",        title: "Database Size",             visible: true },
    ...(models[0] ? [{ id: `block-content-chart-${models[0].tableName}`, type: "content-chart" as const, title: `${models[0].labelPlural} Created`, visible: true, model: models[0].tableName }] : []),
  ]
  for (const m of models.slice(0, 3)) {
    blocks.push({ id: `block-stats-${m.tableName}`,  type: "stats",  title: `Total ${m.labelPlural}`,  visible: true, model: m.tableName })
    blocks.push({ id: `block-recent-${m.tableName}`, type: "recent", title: `Recent ${m.labelPlural}`, visible: true, model: m.tableName })
  }
  return blocks
}
