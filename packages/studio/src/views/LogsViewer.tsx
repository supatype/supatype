import React, { useState, useMemo } from "react"
import { cn } from "../lib/utils.js"
import { Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { SlidePanel } from "../components/SlidePanel.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string
  timestamp: string
  method: string
  path: string
  status: number
  duration: number
  user_id: string | null
  ip: string
  request_id: string
  response_size: number
  request_headers: Record<string, string>
  request_body: string | null
  response_body: string | null
  query_plan: string | null
}

const methodColorClass: Record<string, string> = {
  GET: "text-green-400",
  POST: "text-blue-400",
  PATCH: "text-yellow-400",
  PUT: "text-orange-400",
  DELETE: "text-red-400",
}

function statusColorClass(status: number): string {
  if (status >= 200 && status < 300) return "text-green-400"
  if (status >= 300 && status < 400) return "text-yellow-400"
  if (status >= 400 && status < 500) return "text-orange-400"
  return "text-red-400"
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

// ─── Expanded Log Detail ──────────────────────────────────────────────────────

function LogDetail({ log }: { log: LogEntry }): React.ReactElement {
  return (
    <div>
      <div className="flex items-center gap-2 mb-4 font-mono">
        <span className={cn("font-bold text-sm", methodColorClass[log.method] ?? "text-foreground")}>{log.method}</span>
        <code className="text-sm text-foreground/80 truncate">{log.path}</code>
        <span className={cn("font-bold text-sm ml-auto shrink-0", statusColorClass(log.status))}>{log.status}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Timestamp</label>
          <span className="text-xs font-mono">{new Date(log.timestamp).toLocaleString()}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Duration</label>
          <span className={cn("text-xs font-mono", log.duration > 1000 ? "text-red-400" : log.duration > 100 ? "text-yellow-400" : "text-foreground")}>{log.duration}ms</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Response Size</label>
          <span className="text-xs">{formatBytes(log.response_size)}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Request ID</label>
          <code className="text-xs text-zinc-600">{log.request_id}</code>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">User</label>
          <span className="text-xs">{log.user_id ?? <span className="italic text-zinc-600">anonymous</span>}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">IP</label>
          <span className="text-xs font-mono">{log.ip}</span>
        </div>
      </div>

      {/* Request headers */}
      <div className="mb-4">
        <h4 className="text-xs text-muted-foreground uppercase mb-1">Request Headers</h4>
        <div className="rounded-md border border-border bg-background p-3 font-mono text-xs overflow-x-auto">
          {Object.entries(log.request_headers).map(([key, value]) => (
            <div key={key}>
              <span className="text-muted-foreground">{key}:</span>{" "}
              <span className={key.toLowerCase() === "authorization" ? "text-zinc-600" : "text-foreground"}>
                {key.toLowerCase() === "authorization" ? value.slice(0, 20) + "..." : value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Request body */}
      {log.request_body ? (
        <div className="mb-4">
          <h4 className="text-xs text-muted-foreground uppercase mb-1">Request Body</h4>
          <CodeBlock className="text-xs">
            {(() => {
              try { return JSON.stringify(JSON.parse(log.request_body), null, 2) }
              catch { return log.request_body }
            })()}
          </CodeBlock>
        </div>
      ) : null}

      {/* Response body */}
      {log.response_body ? (
        <div className="mb-4">
          <h4 className="text-xs text-muted-foreground uppercase mb-1">Response Body</h4>
          <CodeBlock className="text-xs max-h-[300px] overflow-y-auto">
            {(() => {
              try { return JSON.stringify(JSON.parse(log.response_body), null, 2) }
              catch { return log.response_body }
            })()}
          </CodeBlock>
        </div>
      ) : null}

      {/* Query plan */}
      {log.query_plan ? (
        <div>
          <h4 className="text-xs text-muted-foreground uppercase mb-1">PostgREST Query Plan</h4>
          <CodeBlock className="text-xs">{log.query_plan}</CodeBlock>
        </div>
      ) : null}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function LogsViewer(): React.ReactElement {
  const [logs] = useState<LogEntry[]>([])
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)

  // Filters
  const [filterMethod, setFilterMethod] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")
  const [filterPath, setFilterPath] = useState("")
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (filterMethod !== "all" && l.method !== filterMethod) return false
      if (filterStatus === "2xx" && (l.status < 200 || l.status >= 300)) return false
      if (filterStatus === "3xx" && (l.status < 300 || l.status >= 400)) return false
      if (filterStatus === "4xx" && (l.status < 400 || l.status >= 500)) return false
      if (filterStatus === "5xx" && l.status < 500) return false
      if (filterPath && !l.path.toLowerCase().includes(filterPath.toLowerCase())) return false
      if (search && !l.path.toLowerCase().includes(search.toLowerCase()) && !l.request_id.includes(search)) return false
      return true
    })
  }, [logs, filterMethod, filterStatus, filterPath, search])

  return (
    <>
      {/* Info banner */}
      <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 flex items-center gap-3 mb-4">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span className="text-sm text-blue-400">
          Request logging is not yet available for this project. This feature is coming soon.
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Input
          className="w-[250px]"
          placeholder="Search by path or request ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-[120px]" value={filterMethod} onChange={(e) => setFilterMethod(e.target.value)}>
          <option value="all">All methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
        </Select>
        <Select className="w-[120px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All status</option>
          <option value="2xx">2xx Success</option>
          <option value="3xx">3xx Redirect</option>
          <option value="4xx">4xx Client</option>
          <option value="5xx">5xx Server</option>
        </Select>
        <Input
          className="w-[180px]"
          placeholder="Filter by path prefix..."
          value={filterPath}
          onChange={(e) => setFilterPath(e.target.value)}
        />
      </div>

      {/* Main content */}
      {logs.length === 0 ? (
        <Card className="overflow-auto">
          <EmptyState
            title="No request logs available yet"
            description="Logs will appear here as requests are made to your project API."
          />
        </Card>
      ) : (
        <>
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Time</Th>
                  <Th>Method</Th>
                  <Th>Path</Th>
                  <Th>Status</Th>
                  <Th>Duration</Th>
                  <Th>Size</Th>
                  <Th>User</Th>
                  <Th>IP</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr
                    key={l.id}
                    className={cn(
                      "border-b border-border hover:bg-accent/50 cursor-pointer",
                      selectedLog?.id === l.id && "bg-primary/5",
                      l.status >= 500 && "bg-red-500/5",
                      l.status >= 400 && l.status < 500 && "bg-orange-500/5"
                    )}
                    onClick={() => setSelectedLog(l)}
                  >
                    <Td className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                      {new Date(l.timestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions)}
                    </Td>
                    <Td>
                      <span className={cn("font-mono font-semibold text-xs", methodColorClass[l.method] ?? "text-foreground")}>
                        {l.method}
                      </span>
                    </Td>
                    <Td className="max-w-[400px]">
                      <code className="text-xs break-all">{l.path}</code>
                    </Td>
                    <Td>
                      <span className={cn("font-mono font-semibold", statusColorClass(l.status))}>
                        {l.status}
                      </span>
                    </Td>
                    <Td className={cn(
                      "text-xs font-mono",
                      l.duration > 1000 ? "text-red-400" :
                      l.duration > 100 ? "text-yellow-400" :
                      "text-muted-foreground"
                    )}>
                      {l.duration}ms
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {formatBytes(l.response_size)}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {l.user_id ?? <span className="italic">anon</span>}
                    </Td>
                    <Td className="text-xs text-zinc-600 font-mono">{l.ip}</Td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-muted-foreground text-sm">
                      No logs match your filters
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>

          <div className="text-xs text-muted-foreground mt-2">
            {filtered.length} logs displayed ({logs.length} total)
          </div>
        </>
      )}

      <SlidePanel
        open={selectedLog !== null}
        onClose={() => setSelectedLog(null)}
        title={selectedLog ? `${selectedLog.method} ${selectedLog.path}` : ""}
        subtitle={selectedLog ? `${selectedLog.status} · ${selectedLog.duration}ms · ${new Date(selectedLog.timestamp).toLocaleString()}` : undefined}
        width="max-w-[560px]"
      >
        {selectedLog && <LogDetail log={selectedLog} />}
      </SlidePanel>
    </>
  )
}
