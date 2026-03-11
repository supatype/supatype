import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Card, Select, Th, Td } from "../components/ui.js"

interface LogEntry {
  id: string
  timestamp: string
  method: string
  path: string
  status: number
  duration: number
  user_id: string | null
  ip: string
}

const mockLogs: LogEntry[] = [
  { id: "l1", timestamp: "2026-03-10T10:30:15Z", method: "GET", path: "/rest/v1/posts?select=*&limit=25", status: 200, duration: 12, user_id: "u1", ip: "127.0.0.1" },
  { id: "l2", timestamp: "2026-03-10T10:30:14Z", method: "POST", path: "/auth/v1/token?grant_type=password", status: 200, duration: 85, user_id: null, ip: "127.0.0.1" },
  { id: "l3", timestamp: "2026-03-10T10:30:10Z", method: "PATCH", path: "/rest/v1/users?id=eq.u1", status: 200, duration: 18, user_id: "u1", ip: "127.0.0.1" },
  { id: "l4", timestamp: "2026-03-10T10:30:05Z", method: "GET", path: "/rest/v1/tags", status: 200, duration: 5, user_id: "u1", ip: "127.0.0.1" },
  { id: "l5", timestamp: "2026-03-10T10:30:00Z", method: "POST", path: "/rest/v1/posts", status: 401, duration: 3, user_id: null, ip: "192.168.1.50" },
  { id: "l6", timestamp: "2026-03-10T10:29:55Z", method: "DELETE", path: "/rest/v1/posts?id=eq.p5", status: 204, duration: 22, user_id: "u3", ip: "127.0.0.1" },
  { id: "l7", timestamp: "2026-03-10T10:29:50Z", method: "GET", path: "/storage/v1/object/avatars/profile.jpg", status: 200, duration: 45, user_id: "u2", ip: "127.0.0.1" },
  { id: "l8", timestamp: "2026-03-10T10:29:45Z", method: "POST", path: "/storage/v1/object/uploads/doc.pdf", status: 200, duration: 320, user_id: "u1", ip: "127.0.0.1" },
]

const methodColorClass: Record<string, string> = {
  GET: "text-green-400",
  POST: "text-blue-400",
  PATCH: "text-yellow-400",
  DELETE: "text-red-400",
}

function statusColorClass(status: number): string {
  if (status >= 200 && status < 300) return "text-green-400"
  if (status >= 300 && status < 400) return "text-yellow-400"
  if (status >= 400 && status < 500) return "text-orange-400"
  return "text-red-400"
}

export function LogsViewer(): React.ReactElement {
  const client = useStudioClient()
  const [logs] = useState<LogEntry[]>(mockLogs)
  const [filterMethod, setFilterMethod] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")

  const filtered = logs.filter((l) => {
    if (filterMethod !== "all" && l.method !== filterMethod) return false
    if (filterStatus === "2xx" && (l.status < 200 || l.status >= 300)) return false
    if (filterStatus === "4xx" && (l.status < 400 || l.status >= 500)) return false
    if (filterStatus === "5xx" && l.status < 500) return false
    return true
  })

  return (
    <>
      <div className="flex items-center justify-end gap-2 mb-4">
        <Select className="w-[120px]" value={filterMethod} onChange={(e) => setFilterMethod(e.target.value)}>
          <option value="all">All methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </Select>
        <Select className="w-[120px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All status</option>
          <option value="2xx">2xx Success</option>
          <option value="4xx">4xx Client</option>
          <option value="5xx">5xx Server</option>
        </Select>
      </div>

      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>Time</Th>
              <Th>Method</Th>
              <Th>Path</Th>
              <Th>Status</Th>
              <Th>Duration</Th>
              <Th>User</Th>
              <Th>IP</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.id} className="border-b border-border hover:bg-accent/50">
                <Td className="text-xs text-muted-foreground font-mono">
                  {new Date(l.timestamp).toLocaleTimeString()}
                </Td>
                <Td>
                  <span className={cn("font-mono font-semibold text-xs", methodColorClass[l.method] ?? "text-foreground")}>
                    {l.method}
                  </span>
                </Td>
                <Td>
                  <code className="text-xs break-all">{l.path}</code>
                </Td>
                <Td>
                  <span className={cn("font-mono font-semibold", statusColorClass(l.status))}>
                    {l.status}
                  </span>
                </Td>
                <Td className={cn("text-xs", l.duration > 100 ? "text-yellow-400" : "text-muted-foreground")}>
                  {l.duration}ms
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {l.user_id ?? <span className="italic">anon</span>}
                </Td>
                <Td className="text-xs text-zinc-600 font-mono">{l.ip}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
