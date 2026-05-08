import React, { useState, useEffect, useCallback, useRef } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useNavigate, useParams } from "react-router-dom"
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

const BUILTIN_RUNTIME_ENV_VARS: Array<{ key: string; description: string }> = [
  { key: "SUPATYPE_URL", description: "API gateway URL for this project." },
  { key: "SUPATYPE_DB_URL", description: "Direct Postgres connection URL (server-only)." },
  { key: "SUPATYPE_PUBLISHABLE_KEYS", description: "JSON dictionary of publishable API keys." },
  { key: "SUPATYPE_SECRET_KEYS", description: "JSON dictionary of secret API keys (server-only)." },
  { key: "SUPATYPE_ANON_KEY", description: "Legacy anon key (deprecated)." },
  { key: "SUPATYPE_SERVICE_ROLE_KEY", description: "Legacy service role key (deprecated)." },
  { key: "SUPATYPE_JWKS", description: "JSON Web Key Set for JWT verification." },
  { key: "SUPATYPE_REGION", description: "Region where function is invoked." },
  { key: "SUPATYPE_EXECUTION_ID", description: "Unique identifier for each invocation." },
  { key: "DENO_DEPLOYMENT_ID", description: "Version/deployment identifier for the function code." },
]

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

// ─── Invoke tab ───────────────────────────────────────────────────────────────

function InvokeTab({
  functionName,
  clientUrl,
  serviceRoleKey,
}: {
  functionName: string
  clientUrl: string
  serviceRoleKey: string | undefined
}): React.ReactElement {
  const [method, setMethod] = useState<"GET" | "POST">("POST")
  const [body, setBody] = useState("{}")
  const [authMode, setAuthMode] = useState<"none" | "service_role" | "custom">("none")
  const [customToken, setCustomToken] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [responseText, setResponseText] = useState("")

  const invoke = async () => {
    setRunning(true)
    setError(null)
    setStatus(null)
    setDurationMs(null)
    setResponseText("")

    try {
      const headers: Record<string, string> = {}
      const opts: RequestInit = { method, headers }

      if (method === "POST") {
        try {
          JSON.parse(body)
        } catch {
          throw new Error("Body must be valid JSON for POST requests")
        }
        headers["Content-Type"] = "application/json"
        opts.body = body
      }

      if (authMode === "service_role") {
        if (!serviceRoleKey) throw new Error("No service role key available in Studio client")
        headers["Authorization"] = `Bearer ${serviceRoleKey}`
      } else if (authMode === "custom") {
        if (!customToken.trim()) throw new Error("Custom Bearer token is empty")
        headers["Authorization"] = `Bearer ${customToken.trim()}`
      }

      const started = performance.now()
      const res = await fetch(`${clientUrl}/functions/v1/${encodeURIComponent(functionName)}`, opts)
      const elapsed = Math.round(performance.now() - started)
      const text = await res.text()

      setStatus(res.status)
      setDurationMs(elapsed)
      try {
        const json = JSON.parse(text)
        setResponseText(JSON.stringify(json, null, 2))
      } catch {
        setResponseText(text)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invoke function")
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-muted-foreground">Method</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as "GET" | "POST")}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="POST">POST</option>
            <option value="GET">GET</option>
          </select>

          <label className="text-xs text-muted-foreground ml-3">Auth</label>
          <select
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as "none" | "service_role" | "custom")}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="none">None</option>
            <option value="service_role">Service role</option>
            <option value="custom">Custom Bearer token</option>
          </select>
        </div>

        {authMode === "custom" && (
          <Input
            placeholder="Bearer token"
            value={customToken}
            onChange={(e) => setCustomToken(e.target.value)}
            className="font-mono text-xs"
          />
        )}

        {method === "POST" && (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          />
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void invoke()} disabled={running}>
            {running ? "Running..." : "Invoke"}
          </Button>
          {status !== null && (
            <span className="text-xs text-muted-foreground">
              Status {status}{durationMs !== null ? ` - ${durationMs}ms` : ""}
            </span>
          )}
        </div>
      </div>

      <Card className="overflow-auto">
        <div className="p-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Response
          </h4>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">{responseText || "No response yet."}</pre>
        </div>
      </Card>
    </div>
  )
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
  functionName,
  adminFetch,
}: {
  functionName: string
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>
}): React.ReactElement {
  const [scope, setScope] = useState<"function" | "shared" | "defaults">("function")
  const [newKey, setNewKey]     = useState("")
  const [newValue, setNewValue] = useState("")
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const envBasePath = scope === "shared"
    ? "/env"
    : `/${encodeURIComponent(functionName)}/env`
  const showDefaults = scope === "defaults"

  const { data, loading, refetch } = useApiQuery<string[]>(
    async () => {
      const res = await adminFetch(envBasePath)
      if (!res.ok) return []
      const json = await res.json() as { data: string[] }
      return json.data ?? []
    },
    [envBasePath],
  )

  const keys = data ?? []

  const handleAdd = async () => {
    if (!newKey.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await adminFetch(envBasePath, {
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
      const res = await adminFetch(`${envBasePath}/${encodeURIComponent(key)}`, { method: "DELETE" })
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

      <div className="mb-5">
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => setScope("function")}
            className={cn(
              "px-2.5 py-1 text-xs rounded transition-colors",
              scope === "function"
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:bg-accent",
            )}
          >
            Function ({functionName})
          </button>
          <button
            type="button"
            onClick={() => setScope("shared")}
            className={cn(
              "px-2.5 py-1 text-xs rounded transition-colors",
              scope === "shared"
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:bg-accent",
            )}
          >
            Shared (all functions)
          </button>
          <button
            type="button"
            onClick={() => setScope("defaults")}
            className={cn(
              "px-2.5 py-1 text-xs rounded transition-colors",
              scope === "defaults"
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:bg-accent",
            )}
          >
            Defaults (read-only)
          </button>
        </div>

        {!showDefaults && (
          <>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Add {scope === "shared" ? "Shared" : "Function"} Variable
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
              Values are write-only; function vars override shared vars with the same key.
            </p>
          </>
        )}
      </div>

      {showDefaults ? (
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Key</Th>
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {BUILTIN_RUNTIME_ENV_VARS.map((item) => (
                <tr key={item.key} className="border-b border-border last:border-0">
                  <Td className="font-mono text-xs">{item.key}</Td>
                  <Td className="text-xs text-muted-foreground">{item.description}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <>
          {/* Key list */}
          {loading && (
            <div className="text-center py-6 text-xs text-muted-foreground">Loading…</div>
          )}

          {!loading && keys.length === 0 && (
            <EmptyState
              title={`No ${scope === "shared" ? "shared" : "function"} environment variables`}
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
        </>
      )}
    </div>
  )
}

// ─── EdgeFunctions ────────────────────────────────────────────────────────────

export function EdgeFunctions(): React.ReactElement {
  const client = useStudioClient()
  const navigate = useNavigate()
  const params = useParams<{ functionSlug?: string; tab?: string }>()
  const activeTab: "logs" | "env" | "invoke" =
    params.tab === "logs"
      ? "logs"
      : params.tab === "env"
        ? "env"
        : "invoke"

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
  const selectedSlug = params.functionSlug ? decodeURIComponent(params.functionSlug) : null
  const selectedFn = (selectedSlug
    ? functions.find((f) => f.name === selectedSlug)
    : undefined) ?? functions[0] ?? null

  // Keep selected function in path; default to top function.
  useEffect(() => {
    if (functions.length === 0) return
    const current = params.functionSlug ? decodeURIComponent(params.functionSlug) : null
    if (current && functions.some((f) => f.name === current)) return
    navigate(`/edge-functions/${encodeURIComponent(functions[0]!.name)}/invoke`, { replace: true })
  }, [functions, params.functionSlug, navigate])

  useEffect(() => {
    if (!params.functionSlug || params.tab) return
    navigate(`/edge-functions/${params.functionSlug}/invoke`, { replace: true })
  }, [params.functionSlug, params.tab, navigate])

  if (error) {
    return <ErrorBanner message={error} />
  }
  if (loading && functions.length === 0) {
    return <div className="text-sm text-muted-foreground">Loading functions...</div>
  }
  if (!loading && functions.length === 0) {
    return (
      <EmptyState
        title="No functions deployed"
        description="Run npx supatype functions deploy to deploy your first function."
      />
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0">
        {!selectedFn ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select a function to view details
          </div>
        ) : (
          <div className="flex flex-col h-full gap-4">
            <div className="flex items-center justify-between gap-3">
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
              <Button size="xs" onClick={refetch}>Refresh</Button>
            </div>
            <div className="flex-1 overflow-auto">
              {activeTab === "invoke" && (
                <InvokeTab
                  functionName={selectedFn.name}
                  clientUrl={client.url}
                  serviceRoleKey={client.serviceRoleKey}
                />
              )}
              {activeTab === "logs" && (
                <LogsTab functionName={selectedFn.name} adminFetch={adminFetch} />
              )}
              {activeTab === "env" && (
                <EnvVarsTab functionName={selectedFn.name} adminFetch={adminFetch} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
