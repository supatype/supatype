import React, { useState, useEffect, useCallback } from "react"
import { useCloud } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

// ─── Types ──────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  userId: string
  userName: string
  userEmail: string
  action: string
  resource: string
  metadata: Record<string, unknown>
  createdAt: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

const ACTION_LABELS: Record<string, string> = {
  "project.created": "Created project",
  "project.deleted": "Deleted project",
  "project.paused": "Paused project",
  "project.resumed": "Resumed project",
  "project.updated": "Updated project",
  "member.invited": "Invited member",
  "member.removed": "Removed member",
  "member.role_changed": "Changed member role",
  "domain.added": "Added domain",
  "domain.removed": "Removed domain",
  "domain.verified": "Verified domain",
  "key.created": "Created API key",
  "key.revoked": "Revoked API key",
  "deployment.created": "Created deployment",
  "deployment.rolled_back": "Rolled back deployment",
  "org.updated": "Updated organisation",
  "org.created": "Created organisation",
  "billing.plan_changed": "Changed billing plan",
  "billing.payment_method_updated": "Updated payment method",
  "environment.created": "Created environment",
  "environment.deleted": "Deleted environment",
}

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function AuditLog(): React.ReactElement {
  const cloud = useCloud()
  const { activeOrg } = cloud
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)

  // Filters
  const [actionFilter, setActionFilter] = useState<string>("")
  const [userFilter, setUserFilter] = useState<string>("")
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")

  const fetchEntries = useCallback(async (pageNum: number, append: boolean) => {
    if (!activeOrg) return
    if (append) setLoadingMore(true)
    else setLoading(true)

    try {
      const params = new URLSearchParams({ page: String(pageNum), perPage: "50" })
      if (actionFilter) params.set("action", actionFilter)
      if (userFilter) params.set("userId", userFilter)
      if (dateFrom) params.set("from", dateFrom)
      if (dateTo) params.set("to", dateTo)

      const res = await fetch(`/api/v1/organisations/${activeOrg.id}/audit-log?${params.toString()}`, {
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) throw new Error("Failed to fetch audit log")
      const json = (await res.json()) as { data: AuditEntry[]; total: number; page: number; perPage: number }

      if (append) {
        setEntries((prev) => [...prev, ...json.data])
      } else {
        setEntries(json.data)
      }
      setHasMore(json.data.length === json.perPage)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log")
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [activeOrg, actionFilter, userFilter, dateFrom, dateTo])

  // Reset and fetch on filter change
  useEffect(() => {
    setPage(1)
    void fetchEntries(1, false)
  }, [fetchEntries])

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    void fetchEntries(nextPage, true)
  }, [page, fetchEntries])

  // Collect unique actions and users for filter dropdowns
  const uniqueActions = Array.from(new Set(entries.map((e) => e.action))).sort()
  const uniqueUsers = Array.from(
    new Map(entries.map((e) => [e.userId, { id: e.userId, name: e.userName, email: e.userEmail }])).values(),
  )

  if (!activeOrg) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Select an organisation to view the audit log.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Audit Log</h2>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground"
        >
          <option value="">All actions</option>
          {uniqueActions.map((action) => (
            <option key={action} value={action}>{humanizeAction(action)}</option>
          ))}
        </select>

        <select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground"
        >
          <option value="">All users</option>
          {uniqueUsers.map((user) => (
            <option key={user.id} value={user.id}>{user.name || user.email}</option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          placeholder="From"
          className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground"
        />

        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          placeholder="To"
          className="px-3 py-1.5 text-xs rounded-md border border-border bg-background text-foreground"
        />

        {(actionFilter || userFilter || dateFrom || dateTo) && (
          <button
            type="button"
            onClick={() => { setActionFilter(""); setUserFilter(""); setDateFrom(""); setDateTo("") }}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-destructive/10 text-destructive rounded-md text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
          Loading audit log...
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
          No audit log entries found.
        </div>
      )}

      {/* Entries */}
      {!loading && entries.length > 0 && (
        <div className="border border-border rounded-lg divide-y divide-border">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
              {/* Avatar */}
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-semibold shrink-0 mt-0.5">
                {(entry.userName || entry.userEmail || "?").charAt(0).toUpperCase()}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">
                    {entry.userName || entry.userEmail}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {humanizeAction(entry.action)}
                  </span>
                  {entry.resource && (
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      {entry.resource}
                    </code>
                  )}
                </div>
                {entry.userName && entry.userEmail && (
                  <div className="text-xs text-muted-foreground mt-0.5">{entry.userEmail}</div>
                )}
              </div>

              {/* Timestamp */}
              <div className="text-xs text-muted-foreground shrink-0">
                {relativeTime(entry.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {!loading && hasMore && entries.length > 0 && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            disabled={loadingMore}
            onClick={handleLoadMore}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-md transition-colors",
              loadingMore
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  )
}
