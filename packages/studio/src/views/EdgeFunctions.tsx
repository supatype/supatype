import React, { useState, useEffect, useCallback, useRef } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { Badge, Button, Card, Input, Th, Td } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { cn } from "../lib/utils.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface FunctionMeta {
  name: string
  deployedAt: string
  invocations24h: number
  avgDurationMs: number
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
}

const TIME_RANGES = [
  { label: "15m", value: "15m" },
  { label: "1h",  value: "1h"  },
  { label: "6h",  value: "6h"  },
  { label: "24h", value: "24h" },
]

function levelVariant(level: string): "green" | "yellow" | "red" | "blue" {
  if (level === "error") return "red"
  if (level === "warn")  return "yellow"
  if (level === "info")  return "green"
  return "blue"
}

// ─── Logs tab ─────────────────────────────────────────────────────────────────

function LogsTab({
  functionName,
  adminFetch,
}: {
  functionName: string
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const [since, setSince] = useState("1h")
  const [autoRefresh, setAutoRefresh] = useState(false)

  const { data, loading, error, refetch } = useApiQuery<LogEntry[]>(
    async () => {
      const res = await adminFetch(`/${encodeURIComponent(functionName)}/logs?since=${since}`)
      if (!res.ok) return []
      const json = await res.json() as { data: LogEntry[] }
      return json.data ?? []
    },
    [functionName, since],
  )

  // Auto-refresh every 10s
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => refetchRef.current(), 10_000)
    return () => clearInterval(id)
  }, [autoRefresh])

  const logs = data ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-1">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.value}
              type="button"
              onClick={() => setSince(tr.value)}
              className={cn(
                "px-2.5 py-1 text-xs rounded transition-colors",
                since === tr.value
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {tr.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
          <Button size="xs" onClick={refetch}>Refresh</Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading && (
        <div className="text-center py-8 text-xs text-muted-foreground">Loading logs…</div>
      )}

      {!loading && logs.length === 0 && (
        <EmptyState
          title="No logs"
          description={`No log entries found in the last ${since}.`}
        />
      )}

      {!loading && logs.length > 0 && (
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Timestamp</Th>
                <Th>Level</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <Td className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </Td>
                  <Td>
                    <Badge variant={levelVariant(log.level)} className="uppercase text-[10px]">
                      {log.level}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs max-w-xs truncate">{log.message}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

// ─── Env Vars tab ─────────────────────────────────────────────────────────────

function EnvVarsTab({
  adminFetch,
}: {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const [newKey, setNewKey]     = useState("")
  const [newValue, setNewValue] = useState("")
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const { data, loading, refetch } = useApiQuery<string[]>(
    async () => {
      const res = await adminFetch("/env")
      if (!res.ok) return []
      const json = await res.json() as { data: string[] }
      return json.data ?? []
    },
    [],
  )

  const keys = data ?? []

  const handleAdd = async () => {
    if (!newKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await adminFetch("/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error ?? "Failed to set variable")
      }
      setNewKey("")
      setNewValue("")
      refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (key: string) => {
    try {
      const res = await adminFetch(`/env/${encodeURIComponent(key)}`, { method: "DELETE" })
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error ?? "Failed to delete variable")
      }
      refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    }
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      {/* Add form */}
      <div className="mb-5">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Add Variable
        </h4>
        <div className="flex gap-2 flex-wrap">
          <Input
            placeholder="KEY"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="font-mono text-xs w-40"
          />
          <Input
            type="password"
            placeholder="value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            className="font-mono text-xs flex-1 min-w-[120px]"
          />
          <Button size="sm" onClick={() => void handleAdd()} disabled={saving || !newKey.trim()}>
            {saving ? "Saving…" : "Add"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Values are write-only — they are never shown after saving.
        </p>
      </div>

      {/* Key list */}
      {loading && (
        <div className="text-center py-6 text-xs text-muted-foreground">Loading…</div>
      )}

      {!loading && keys.length === 0 && (
        <EmptyState
          title="No environment variables"
          description="Add variables above to inject them into your edge functions at runtime."
        />
      )}

      {!loading && keys.length > 0 && (
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Key</Th>
                <Th>Value</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key} className="border-b border-border last:border-0">
                  <Td className="font-mono text-xs">{key}</Td>
                  <Td className="text-xs text-muted-foreground font-mono">••••••••</Td>
                  <Td>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => void handleDelete(key)}
                    >
                      Delete
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

// ─── EdgeFunctions ────────────────────────────────────────────────────────────

export function EdgeFunctions(): React.ReactElement {
  const client = useStudioClient()
  const [selectedFn, setSelectedFn] = useState<FunctionMeta | null>(null)
  const [activeTab, setActiveTab] = useState<"logs" | "env">("logs")

  const adminFetch = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`${client.url}/functions/v1/admin${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(client.serviceRoleKey && { Authorization: `Bearer ${client.serviceRoleKey}` }),
          ...init?.headers,
        },
      }),
    [client.url, client.serviceRoleKey],
  )

  const { data, loading, error, refetch } = useApiQuery<FunctionMeta[]>(
    async () => {
      const res = await adminFetch("/list")
      if (!res.ok) return []
      const json = await res.json() as { data: FunctionMeta[] }
      return json.data ?? []
    },
    [adminFetch],
  )

  const functions = data ?? []

  // Keep selected function in sync if list changes
  useEffect(() => {
    if (selectedFn && !functions.find((f) => f.name === selectedFn.name)) {
      setSelectedFn(null)
    }
  }, [functions, selectedFn])

  return (
    <div className="flex h-full gap-4">
      {/* ── Function list (left panel) ───────────────────────────────────────── */}
      <div className="w-72 shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Edge Functions</h2>
          <Button size="xs" onClick={refetch}>Refresh</Button>
        </div>

        {error && <ErrorBanner message={error} />}

        {loading && (
          <div className="text-center py-8 text-xs text-muted-foreground">Loading…</div>
        )}

        {!loading && functions.length === 0 && (
          <EmptyState
            title="No functions deployed"
            description="Run npx supatype functions deploy to deploy your first function."
          />
        )}

        {!loading && functions.length > 0 && (
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Name</Th>
                  <Th className="text-right">24h</Th>
                </tr>
              </thead>
              <tbody>
                {functions.map((fn) => (
                  <tr
                    key={fn.name}
                    onClick={() => { setSelectedFn(fn); setActiveTab("logs") }}
                    className={cn(
                      "border-b border-border last:border-0 cursor-pointer transition-colors",
                      selectedFn?.name === fn.name
                        ? "bg-accent"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <Td className="font-mono text-xs">{fn.name}</Td>
                    <Td className="text-xs text-muted-foreground text-right">
                      {fn.invocations24h.toLocaleString()}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {/* ── Detail panel (right) ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {!selectedFn ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a function to view details
          </div>
        ) : (
          <div className="flex flex-col h-full gap-4">
            {/* Header */}
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium font-mono">{selectedFn.name}</h3>
              {selectedFn.avgDurationMs > 0 && (
                <span className="text-xs text-muted-foreground">
                  avg {selectedFn.avgDurationMs}ms
                </span>
              )}
              {selectedFn.deployedAt && (
                <span className="text-xs text-muted-foreground">
                  deployed {new Date(selectedFn.deployedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border pb-0">
              {(["logs", "env"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "px-3 pb-2 text-xs font-medium transition-colors border-b-2 -mb-px",
                    activeTab === tab
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab === "logs" ? "Logs" : "Environment Variables"}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-auto">
              {activeTab === "logs" && (
                <LogsTab functionName={selectedFn.name} adminFetch={adminFetch} />
              )}
              {activeTab === "env" && (
                <EnvVarsTab adminFetch={adminFetch} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
