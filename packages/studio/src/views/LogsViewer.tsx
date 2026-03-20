import React, { useState, useEffect, useMemo } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

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

interface LogFilter {
  method: string
  statusGroup: string
  pathPrefix: string
  timeFrom: string
  timeTo: string
  search: string
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockLogs: LogEntry[] = [
  {
    id: "l1", timestamp: "2026-03-10T10:30:15.123Z", method: "GET",
    path: "/rest/v1/posts?select=*,author:users(name)&status=eq.published&limit=25",
    status: 200, duration: 12, user_id: "u1", ip: "192.168.1.10", request_id: "req-001",
    response_size: 4520,
    request_headers: { "authorization": "Bearer eyJ...abc", "apikey": "anon-key", "accept": "application/json", "x-client-info": "supatype-js/0.1.0" },
    request_body: null,
    response_body: '[{"id":"p1","title":"Hello World","author":{"name":"Alice"}}]',
    query_plan: "Limit  (cost=0.00..1.24 rows=10 width=128)\n  ->  Seq Scan on posts  (cost=0.00..1.42 rows=42 width=128)\n        Filter: (status = 'published'::text)",
  },
  {
    id: "l2", timestamp: "2026-03-10T10:30:14.456Z", method: "POST",
    path: "/auth/v1/token?grant_type=password",
    status: 200, duration: 85, user_id: null, ip: "192.168.1.10", request_id: "req-002",
    response_size: 1240,
    request_headers: { "content-type": "application/json", "apikey": "anon-key" },
    request_body: '{"email":"alice@example.com","password":"***"}',
    response_body: '{"access_token":"eyJ...","token_type":"bearer","expires_in":3600}',
    query_plan: null,
  },
  {
    id: "l3", timestamp: "2026-03-10T10:30:10.789Z", method: "PATCH",
    path: "/rest/v1/users?id=eq.u1",
    status: 200, duration: 18, user_id: "u1", ip: "192.168.1.10", request_id: "req-003",
    response_size: 320,
    request_headers: { "authorization": "Bearer eyJ...abc", "apikey": "anon-key", "content-type": "application/json", "prefer": "return=representation" },
    request_body: '{"name":"Alice Updated"}',
    response_body: '{"id":"u1","email":"alice@example.com","name":"Alice Updated"}',
    query_plan: null,
  },
  {
    id: "l4", timestamp: "2026-03-10T10:30:05.012Z", method: "GET",
    path: "/rest/v1/tags",
    status: 200, duration: 5, user_id: "u1", ip: "192.168.1.10", request_id: "req-004",
    response_size: 890,
    request_headers: { "authorization": "Bearer eyJ...abc", "apikey": "anon-key" },
    request_body: null,
    response_body: '[{"id":"t1","name":"TypeScript","slug":"typescript"}]',
    query_plan: "Seq Scan on tags  (cost=0.00..1.12 rows=12 width=64)",
  },
  {
    id: "l5", timestamp: "2026-03-10T10:30:00.345Z", method: "POST",
    path: "/rest/v1/posts",
    status: 401, duration: 3, user_id: null, ip: "192.168.1.50", request_id: "req-005",
    response_size: 128,
    request_headers: { "content-type": "application/json" },
    request_body: '{"title":"Unauthorized post"}',
    response_body: '{"message":"JWT token is missing","hint":"No Authorization header found"}',
    query_plan: null,
  },
  {
    id: "l6", timestamp: "2026-03-10T10:29:55.678Z", method: "DELETE",
    path: "/rest/v1/posts?id=eq.p5",
    status: 204, duration: 22, user_id: "u3", ip: "192.168.1.20", request_id: "req-006",
    response_size: 0,
    request_headers: { "authorization": "Bearer eyJ...xyz", "apikey": "anon-key" },
    request_body: null,
    response_body: null,
    query_plan: null,
  },
  {
    id: "l7", timestamp: "2026-03-10T10:29:50.901Z", method: "GET",
    path: "/storage/v1/object/avatars/profile.jpg",
    status: 200, duration: 45, user_id: "u2", ip: "192.168.1.15", request_id: "req-007",
    response_size: 245760,
    request_headers: { "authorization": "Bearer eyJ...def" },
    request_body: null,
    response_body: "[binary image data]",
    query_plan: null,
  },
  {
    id: "l8", timestamp: "2026-03-10T10:29:45.234Z", method: "POST",
    path: "/storage/v1/object/uploads/doc.pdf",
    status: 200, duration: 320, user_id: "u1", ip: "192.168.1.10", request_id: "req-008",
    response_size: 64,
    request_headers: { "authorization": "Bearer eyJ...abc", "content-type": "application/pdf", "content-length": "1048576" },
    request_body: "[binary PDF data]",
    response_body: '{"Key":"uploads/doc.pdf"}',
    query_plan: null,
  },
  {
    id: "l9", timestamp: "2026-03-10T10:29:40.567Z", method: "GET",
    path: "/rest/v1/posts?select=count",
    status: 500, duration: 2500, user_id: "u1", ip: "192.168.1.10", request_id: "req-009",
    response_size: 256,
    request_headers: { "authorization": "Bearer eyJ...abc", "apikey": "anon-key" },
    request_body: null,
    response_body: '{"message":"connection to server at \\"localhost\\" failed: timeout expired","code":"PGRST301"}',
    query_plan: null,
  },
  {
    id: "l10", timestamp: "2026-03-10T10:29:35.890Z", method: "GET",
    path: "/rest/v1/users?select=id,email&order=created_at.desc&limit=50",
    status: 200, duration: 8, user_id: "u3", ip: "192.168.1.20", request_id: "req-010",
    response_size: 3200,
    request_headers: { "authorization": "Bearer eyJ...xyz", "apikey": "service-role-key" },
    request_body: null,
    response_body: '[{"id":"u1","email":"alice@example.com"},{"id":"u2","email":"bob@example.com"}]',
    query_plan: "Limit  (cost=1.14..1.17 rows=12 width=64)\n  ->  Sort  (cost=1.14..1.17 rows=12 width=64)\n        Sort Key: created_at DESC",
  },
]

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

function LogDetail({ log, onClose }: { log: LogEntry; onClose: () => void }): React.ReactElement {
  return (
    <Card className="p-4 mt-3">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-2">
          <span className={cn("font-mono font-bold", methodColorClass[log.method] ?? "text-foreground")}>{log.method}</span>
          <code className="text-sm">{log.path}</code>
          <span className={cn("font-mono font-bold", statusColorClass(log.status))}>{log.status}</span>
        </div>
        <Button size="xs" onClick={onClose}>Close</Button>
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
    </Card>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function LogsViewer(): React.ReactElement {
  const client = useStudioClient()

  const [logs, setLogs] = useState<LogEntry[]>(mockLogs)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)

  // Filters
  const [filterMethod, setFilterMethod] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")
  const [filterPath, setFilterPath] = useState("")
  const [filterTimeFrom, setFilterTimeFrom] = useState("")
  const [filterTimeTo, setFilterTimeTo] = useState("")
  const [search, setSearch] = useState("")

  // Simulated real-time log streaming
  useEffect(() => {
    if (paused) return

    const interval = setInterval(() => {
      const methods = ["GET", "POST", "PATCH", "DELETE"]
      const paths = ["/rest/v1/posts", "/rest/v1/users", "/auth/v1/token", "/storage/v1/object/avatars/img.png"]
      const statuses = [200, 200, 200, 201, 204, 401, 404, 500]
      const method = methods[Math.floor(Math.random() * methods.length)]!
      const path = paths[Math.floor(Math.random() * paths.length)]!
      const status = statuses[Math.floor(Math.random() * statuses.length)]!

      const newLog: LogEntry = {
        id: `l-${Date.now()}`,
        timestamp: new Date().toISOString(),
        method,
        path,
        status,
        duration: Math.floor(Math.random() * 300) + 1,
        user_id: Math.random() > 0.3 ? `u${Math.floor(Math.random() * 5) + 1}` : null,
        ip: "192.168.1." + Math.floor(Math.random() * 50 + 1),
        request_id: `req-${Date.now()}`,
        response_size: Math.floor(Math.random() * 10000),
        request_headers: { "content-type": "application/json" },
        request_body: method === "POST" || method === "PATCH" ? '{"data":"..."}' : null,
        response_body: status < 300 ? '{"ok":true}' : '{"error":"..."}',
        query_plan: null,
      }

      setLogs((prev) => [newLog, ...prev.slice(0, 199)])
    }, 3000)

    return () => clearInterval(interval)
  }, [paused])

  // Filtered logs
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

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          {!paused ? (
            <Badge variant="green" className="animate-pulse">Live</Badge>
          ) : (
            <Badge variant="yellow">Paused</Badge>
          )}
          <Button size="sm" onClick={() => setPaused(!paused)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" onClick={() => setLogs([])}>
            Clear
          </Button>
        </div>
      </div>

      {/* Log table */}
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
              <React.Fragment key={l.id}>
                <tr
                  className={cn(
                    "border-b border-border hover:bg-accent/50 cursor-pointer",
                    expandedLog === l.id && "bg-primary/5",
                    l.status >= 500 && "bg-red-500/5",
                    l.status >= 400 && l.status < 500 && "bg-orange-500/5"
                  )}
                  onClick={() => setExpandedLog(expandedLog === l.id ? null : l.id)}
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
                {expandedLog === l.id ? (
                  <tr>
                    <td colSpan={8} className="p-0">
                      <LogDetail log={l} onClose={() => setExpandedLog(null)} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
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
  )
}
