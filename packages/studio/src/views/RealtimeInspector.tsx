import React, { useState, useCallback } from "react"
import { usePlatformFetch, usePlatform } from "../hooks/usePlatform.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { Badge, Button, Card, Input, Th, Td } from "../components/ui.js"
import { CloudUpsell } from "./CloudUpsell.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { cn } from "../lib/utils.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface RealtimeStats {
  connectionCount: number
  connectionLimit: number
  tier: string
}

interface RealtimeTableOverride {
  name: string
  insertEnabled: boolean
  updateEnabled: boolean
  deleteEnabled: boolean
  authMode: "rls" | "authenticated" | "public"
}

interface RealtimeSettings {
  tables: RealtimeTableOverride[]
  broadcastPayloadLimitKb: number
  rlsCacheTtlSeconds: number
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  projectRef,
  pf,
}: {
  projectRef: string
  pf: (url: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const { data, loading, error, refetch } = useApiQuery<RealtimeStats>(
    async () => {
      const res = await pf(`projects/${projectRef}/realtime/stats`)
      if (!res.ok) throw new Error("Failed to load stats")
      const json = await res.json() as { data: RealtimeStats }
      return json.data
    },
    [projectRef],
  )

  const stats = data ?? { connectionCount: 0, connectionLimit: 200, tier: "free" }
  const pct = stats.connectionLimit > 0 ? (stats.connectionCount / stats.connectionLimit) * 100 : 0
  const gaugeColor = pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-yellow-500" : "bg-green-500"

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Button size="xs" onClick={refetch}>Refresh</Button>
      </div>

      {error && <ErrorBanner message={error}  />}

      {loading && (
        <div className="text-center py-8 text-xs text-muted-foreground">Loading…</div>
      )}

      {!loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Active Connections
              </p>
              <p className="text-2xl font-bold text-foreground">
                {stats.connectionCount.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground ml-1">
                  / {stats.connectionLimit.toLocaleString()}
                </span>
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Tier
              </p>
              <Badge variant="blue" className="capitalize text-xs">{stats.tier}</Badge>
            </Card>
          </div>

          {/* Connection limit gauge */}
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-2">
              Connection limit — {pct.toFixed(0)}% used
            </p>
            <div className="h-2 w-full rounded-full bg-accent overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", gaugeColor)}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

function SettingsTab({
  projectRef,
  pf,
}: {
  projectRef: string
  pf: (url: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const [saving, setSaving]     = useState(false)
  const [saved,  setSaved]      = useState(false)
  const [error,  setError]      = useState<string | null>(null)
  const [newTable, setNewTable] = useState("")

  const { data, loading, refetch } = useApiQuery<RealtimeSettings>(
    async () => {
      const res = await pf(`projects/${projectRef}/realtime/settings`)
      if (!res.ok) throw new Error("Failed to load settings")
      const json = await res.json() as { data: RealtimeSettings }
      return json.data
    },
    [projectRef],
  )

  const [settings, setSettings] = useState<RealtimeSettings | null>(null)
  // Keep local state in sync with fetched data
  React.useEffect(() => {
    if (data) setSettings(data)
  }, [data])

  const current = settings ?? data ?? {
    tables: [],
    broadcastPayloadLimitKb: 256,
    rlsCacheTtlSeconds: 5,
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await pf(`projects/${projectRef}/realtime/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      })
      if (!res.ok) throw new Error("Failed to save settings")
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const updateTable = (name: string, field: keyof RealtimeTableOverride, value: unknown) => {
    setSettings((prev) => {
      const base = prev ?? current
      return {
        ...base,
        tables: base.tables.map((t) =>
          t.name === name ? { ...t, [field]: value } : t,
        ),
      }
    })
  }

  const addTable = () => {
    if (!newTable.trim()) return
    setSettings((prev) => {
      const base = prev ?? current
      if (base.tables.find((t) => t.name === newTable.trim())) return base
      return {
        ...base,
        tables: [
          ...base.tables,
          { name: newTable.trim(), insertEnabled: true, updateEnabled: true, deleteEnabled: true, authMode: "rls" },
        ],
      }
    })
    setNewTable("")
  }

  const removeTable = (name: string) => {
    setSettings((prev) => {
      const base = prev ?? current
      return { ...base, tables: base.tables.filter((t) => t.name !== name) }
    })
  }

  if (loading) {
    return <div className="text-center py-8 text-xs text-muted-foreground">Loading…</div>
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {error && <ErrorBanner message={error} />}

      {/* Global settings */}
      <Card className="p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Global Settings
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-foreground mb-1.5">Broadcast payload limit (KB)</label>
            <Input
              type="number"
              value={current.broadcastPayloadLimitKb}
              onChange={(e) => setSettings((prev) => ({
                ...(prev ?? current),
                broadcastPayloadLimitKb: parseInt(e.target.value, 10) || 256,
              }))}
              className="w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-foreground mb-1.5">RLS cache TTL (seconds)</label>
            <Input
              type="number"
              value={current.rlsCacheTtlSeconds}
              onChange={(e) => setSettings((prev) => ({
                ...(prev ?? current),
                rlsCacheTtlSeconds: parseInt(e.target.value, 10) || 5,
              }))}
              className="w-full text-xs"
            />
          </div>
        </div>
      </Card>

      {/* Per-table overrides */}
      <Card className="p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Per-table Event Controls
        </h4>

        {current.tables.length > 0 && (
          <div className="overflow-auto mb-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Table</Th>
                  <Th className="text-center">INSERT</Th>
                  <Th className="text-center">UPDATE</Th>
                  <Th className="text-center">DELETE</Th>
                  <Th>Auth Mode</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {current.tables.map((t) => (
                  <tr key={t.name} className="border-b border-border last:border-0">
                    <Td className="font-mono text-xs">{t.name}</Td>
                    {(["insertEnabled", "updateEnabled", "deleteEnabled"] as const).map((field) => (
                      <Td key={field} className="text-center">
                        <input
                          type="checkbox"
                          checked={t[field]}
                          onChange={(e) => updateTable(t.name, field, e.target.checked)}
                          className="rounded"
                        />
                      </Td>
                    ))}
                    <Td>
                      <select
                        value={t.authMode}
                        onChange={(e) => updateTable(t.name, "authMode", e.target.value)}
                        className="text-xs bg-background border border-border rounded px-2 py-1"
                      >
                        <option value="rls">RLS</option>
                        <option value="authenticated">Authenticated</option>
                        <option value="public">Public</option>
                      </select>
                    </Td>
                    <Td>
                      <Button size="xs" variant="ghost" onClick={() => removeTable(t.name)}>
                        Remove
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="table name"
            value={newTable}
            onChange={(e) => setNewTable(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addTable() }}
            className="text-xs font-mono flex-1"
          />
          <Button size="sm" onClick={addTable} disabled={!newTable.trim()}>
            Add table override
          </Button>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save Settings"}
        </Button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </div>
  )
}

// ─── Broadcast Tester tab ─────────────────────────────────────────────────────

function BroadcastTesterTab({
  projectRef,
  pf,
}: {
  projectRef: string
  pf: (url: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const [channel, setChannel]   = useState("public:test")
  const [event,   setEvent]     = useState("test-event")
  const [payload, setPayload]   = useState('{\n  "message": "hello"\n}')
  const [sending, setSending]   = useState(false)
  const [result,  setResult]    = useState<string | null>(null)
  const [error,   setError]     = useState<string | null>(null)

  const handleSend = useCallback(async () => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      setError("Payload must be valid JSON")
      return
    }

    setSending(true)
    setError(null)
    setResult(null)
    try {
      const res = await pf(`projects/${projectRef}/realtime/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, event, payload: parsed }),
      })
      if (!res.ok) {
        const json = await res.json() as { message?: string }
        throw new Error(json.message ?? "Broadcast failed")
      }
      setResult(`Message sent to channel "${channel}"`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setSending(false)
    }
  }, [pf, projectRef, channel, event, payload])

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <label className="block text-xs text-foreground mb-1.5">Channel</label>
        <Input
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          placeholder="public:posts"
          className="font-mono text-xs w-full"
        />
      </div>

      <div>
        <label className="block text-xs text-foreground mb-1.5">Event</label>
        <Input
          value={event}
          onChange={(e) => setEvent(e.target.value)}
          placeholder="new-post"
          className="font-mono text-xs w-full"
        />
      </div>

      <div>
        <label className="block text-xs text-foreground mb-1.5">Payload (JSON)</label>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          spellCheck={false}
          className={cn(
            "w-full font-mono text-xs rounded-md border border-border bg-background px-3 py-2",
            "focus:outline-none focus:ring-2 focus:ring-ring resize-y",
          )}
        />
      </div>

      {error  && <ErrorBanner message={error} />}
      {result && (
        <div className="rounded-md bg-green-500/10 border border-green-500/30 px-4 py-2 text-xs text-green-400">
          {result}
        </div>
      )}

      <Button onClick={() => void handleSend()} disabled={sending || !channel || !event}>
        {sending ? "Sending…" : "Send Broadcast"}
      </Button>
    </div>
  )
}

// ─── RealtimeInspector ────────────────────────────────────────────────────────

export function RealtimeInspector(): React.ReactElement {
  const pf = usePlatformFetch()
  const { projectRef } = usePlatform()
  const [activeTab, setActiveTab] = useState<"overview" | "settings" | "broadcast">("overview")

  // Self-hosted / no platformUrl → show upsell
  if (!pf || !projectRef) {
    return (
      <CloudUpsell
        title="Realtime Inspector"
        description="Monitor active channels, connected clients, message throughput, and configure your realtime service."
        features={[
          "Live connection count with tier limit gauge",
          "Per-table event type controls (INSERT / UPDATE / DELETE)",
          "Channel authorisation mode (RLS / authenticated / public)",
          "Broadcast tester — send messages to channels without writing code",
          "RLS cache TTL and payload size configuration",
        ]}
      />
    )
  }

  const TABS = [
    { id: "overview",   label: "Overview"         },
    { id: "settings",   label: "Settings"         },
    { id: "broadcast",  label: "Broadcast Tester" },
  ] as const

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-base font-semibold text-foreground mb-1">Realtime Inspector</h1>
        <p className="text-sm text-muted-foreground">
          Monitor connections and configure realtime settings for this project.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-4 pb-2 text-sm font-medium transition-colors border-b-2 -mb-px",
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview"  && <OverviewTab    projectRef={projectRef} pf={pf} />}
      {activeTab === "settings"  && <SettingsTab    projectRef={projectRef} pf={pf} />}
      {activeTab === "broadcast" && <BroadcastTesterTab projectRef={projectRef} pf={pf} />}
    </div>
  )
}
