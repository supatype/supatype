import React, { useState, useEffect, useCallback } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { Badge, Button, Card, Checkbox, Input, Select, Table, Tabs, Textarea, Th, Td, type TabItem } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { useFunctionLogTail } from "../hooks/useFunctionLogTail.js"
import { useInterval } from "../hooks/useTabActivity.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import {
  type Guard,
  isNumber,
  isOneOf,
  isShape,
  isString,
  nullable,
  optional,
  readJson,
} from "../lib/json.js"
import { functionsAdminError, functionsAdminFetch, isDataList } from "../lib/functions-admin.js"
import { useSendAs } from "../hooks/useSendAs.js"
import { SendAsField } from "../components/SendAsField.js"
import { usePlatform } from "../hooks/usePlatform.js"
import { FunctionSecrets } from "./FunctionSecrets.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface FunctionMeta {
  name: string
  /** Absent when the runtime could not stat the function's file. */
  deployedAt?: string | null
  invocations24h: number
  avgDurationMs: number
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
}

const isFunctionMeta: Guard<FunctionMeta> = isShape({
  name: isString,
  deployedAt: optional(nullable(isString)),
  invocations24h: isNumber,
  avgDurationMs: isNumber,
})

const isLogEntry: Guard<LogEntry> = isShape({ timestamp: isString, level: isString, message: isString })

const isHttpMethod = isOneOf(["GET", "POST"] as const)
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

/** The secret scopes a function's Secrets tab switches between. */
function scopeTabs(functionName: string): Array<TabItem<SecretsScope>> {
  return [
    { id: "shared", label: "Shared (all functions)" },
    { id: "function", label: `Function (${functionName})` },
    { id: "defaults", label: "Defaults (read-only)" },
  ]
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

// ─── Invoke tab ───────────────────────────────────────────────────────────────

function buildFunctionInvokeUrl(clientUrl: string, functionName: string, queryString: string): string {
  const base = `${clientUrl.replace(/\/$/, "")}/functions/v1/${encodeURIComponent(functionName)}`
  const raw = queryString.trim()
  if (!raw) return base
  const qs = raw.startsWith("?") ? raw.slice(1) : raw
  return `${base}?${qs}`
}

/** Invoke a function, by default as the signed-in Studio user. Exported for its suite. */
export function InvokeTab({
  functionName,
  clientUrl,
}: {
  functionName: string
  clientUrl: string
}): React.ReactElement {
  const [method, setMethod] = useState<"GET" | "POST">("POST")
  const [queryString, setQueryString] = useState("")
  const [body, setBody] = useState("{}")
  // The signed-in user unless the editor picks otherwise (`send-as.ts`).
  const sendAs = useSendAs()
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

      if (sendAs.choice === "token" && !sendAs.token.trim()) throw new Error("The pasted token is empty")
      Object.assign(headers, sendAs.headers())

      const started = performance.now()
      const url = buildFunctionInvokeUrl(clientUrl, functionName, queryString)
      const res = await fetch(url, opts)
      const elapsed = Math.round(performance.now() - started)
      const text = await res.text()

      setStatus(res.status)
      setDurationMs(elapsed)
      try {
        const json: unknown = JSON.parse(text)
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
          <Select
            aria-label="Method"
            value={method}
            onChange={(e) => { const next = e.target.value; if (isHttpMethod(next)) setMethod(next) }}
            className="px-2 py-1 text-xs"
          >
            <option value="POST">POST</option>
            <option value="GET">GET</option>
          </Select>

        </div>

        <div>
          <label className="text-xs text-muted-foreground">Query string</label>
          <Input
            placeholder="token=your-export-token"
            value={queryString}
            onChange={(e) => setQueryString(e.target.value)}
            className="font-mono text-xs mt-1"
          />
        </div>

        <SendAsField sendAs={sendAs} />

        {method === "POST" && (
          <Textarea
            aria-label="Request body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="text-xs"
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
  // Live by default. The query below answers from the server's own Deno manager, which exists only
  // when the server supervises Deno itself: in Compose and on cloud the functions run in a separate
  // worker and it returns nothing at all. The tail is where the lines actually are.
  const [live, setLive] = useState(true)

  const tail = useFunctionLogTail(functionName, live, adminFetch)
  // A deployment running functions in-process has no worker to tail, and the query is the right
  // answer there. Falling back rather than reporting a failure means neither shape has to be
  // configured by hand.
  const tailing = live && tail.state.kind !== "unsupported"

  const { data, loading, error, refetch } = useApiQuery<LogEntry[]>(
    async () => {
      if (tailing) return []
      const res = await adminFetch(`/${encodeURIComponent(functionName)}/logs?since=${since}`)
      if (!res.ok) throw await functionsAdminError(res, "Could not read logs")
      const json = await readJson(res, isDataList(isLogEntry))
      return json.data ?? []
    },
    [functionName, since, tailing],
  )

  // Auto-refresh every 10s
  useInterval(refetch, autoRefresh && !tailing ? 10_000 : null)

  const logs: LogEntry[] = tailing ? tail.lines : data ?? []
  // A refused query is not an empty history, so it shows the refusal and not "No logs".
  const queryFailed = !tailing && error !== null

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-1">
          {/* A time range is a question about history, and a live tail keeps none, so the control
              is hidden rather than shown doing nothing. */}
          {!tailing && (
            <Tabs tabs={{ label: "Time range", items: TIME_RANGES.map((tr) => ({ id: tr.value, label: tr.label })), look: "pill", size: "xs" }} value={since} onChange={setSince} />
          )}
          {tailing && (
            <Badge variant={tail.state.kind === "streaming" ? "green" : "yellow"}>
              {tail.state.kind === "streaming" ? "Live" : "Connecting…"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox label="Live tail" checked={live} onChange={(e) => setLive(e.target.checked)} />
          {!tailing && (
            <Checkbox label="Auto-refresh" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          )}
          <Button size="xs" onClick={tailing ? tail.clear : refetch}>
            {tailing ? "Clear" : "Refresh"}
          </Button>
        </div>
      </div>

      {queryFailed && <ErrorBanner message={error} />}
      {tailing && tail.state.kind === "error" && <ErrorBanner message={tail.state.message} />}

      {live && tail.state.kind === "unsupported" && (
        <div className="mb-3 text-xs text-muted-foreground">
          This deployment runs functions in the server process, so there is no worker to tail.
          Showing recent logs instead.
        </div>
      )}

      {loading && !tailing && (
        <div className="text-center py-8 text-xs text-muted-foreground">Loading logs…</div>
      )}

      {logs.length === 0 && !queryFailed && !(loading && !tailing) && (
        <EmptyState
          title={tailing ? "Waiting for output" : "No logs"}
          description={
            tailing
              ? `Nothing logged yet. Invoke ${functionName} and its output appears here.`
              : `No log entries found in the last ${since}.`
          }
        />
      )}

      {logs.length > 0 && (
        <Card className="overflow-auto">
          <Table>
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
          </Table>
        </Card>
      )}
    </div>
  )
}

// ─── Secrets tab ──────────────────────────────────────────────────────────────

type SecretsScope = "function" | "shared" | "defaults"

/**
 * The secrets the functions receive: the shared store every function and data hook reads, one
 * function's own (self-host only, Cloud has no such store), and the read-only defaults the runtime
 * sets. Both stores are the one `FunctionSecrets` component.
 */
function EnvVarsTab({ functionName, scopes }: { functionName: string; scopes: ReadonlyArray<SecretsScope> }): React.ReactElement {
  const [scope, setScope] = useState<SecretsScope>("shared")
  const items = scopeTabs(functionName).filter((tab) => scopes.includes(tab.id))

  return (
    <div>
      <div className="mb-3">
        <Tabs tabs={{ label: "Secret scope", items, look: "pill", size: "xs" }} value={scope} onChange={setScope} />
      </div>

      {scope === "shared" && <FunctionSecrets />}
      {scope === "function" && <FunctionSecrets key={functionName} scope={{ kind: "function", name: functionName }} />}
      {scope === "defaults" && (
        <Card className="overflow-auto">
          <Table>
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
          </Table>
        </Card>
      )}
    </div>
  )
}

// ─── EdgeFunctions ────────────────────────────────────────────────────────────

export function EdgeFunctions(): React.ReactElement {
  const client = useStudioClient()
  const navigate = useNavigate()
  const location = useLocation()
  // Cloud keeps one store of secrets for the project, so a function has none of its own there.
  const scopes: ReadonlyArray<SecretsScope> = usePlatform().platformUrl === undefined ? ["shared", "function", "defaults"] : ["shared", "defaults"]
  const params = useParams<{ functionSlug?: string; tab?: string }>()
  const activeTab: "logs" | "env" | "invoke" =
    params.tab === "logs"
      ? "logs"
      : params.tab === "env"
        ? "env"
        : "invoke"

  const adminFetch = useCallback(
    (path: string, init?: RequestInit) => functionsAdminFetch(client, path, init),
    [client],
  )

  const { data, loading, error, refetch } = useApiQuery<FunctionMeta[]>(
    async () => {
      const res = await adminFetch("/list")
      if (!res.ok) throw await functionsAdminError(res, "Could not list functions")
      const json = await readJson(res, isDataList(isFunctionMeta))
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
    // `?tab=env` is how another section sends the editor to the secrets, whichever function is first.
    const wanted = new URLSearchParams(location.search).get("tab")
    navigate(`/edge-functions/${encodeURIComponent(functions[0]!.name)}/${wanted === "env" || wanted === "logs" ? wanted : "invoke"}`, { replace: true })
  }, [functions, params.functionSlug, location.search, navigate])

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
    // Secrets are the project's, so they can be set before the first function is deployed.
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          title="No functions deployed"
          description="Run npx supatype functions deploy to deploy your first function."
        />
        <FunctionSecrets />
      </div>
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
                  key={selectedFn.name}
                  functionName={selectedFn.name}
                  clientUrl={client.url}
                />
              )}
              {activeTab === "logs" && (
                <LogsTab functionName={selectedFn.name} adminFetch={adminFetch} />
              )}
              {activeTab === "env" && (
                <EnvVarsTab functionName={selectedFn.name} scopes={scopes} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
