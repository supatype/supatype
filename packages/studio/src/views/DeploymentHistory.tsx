import React, { useState, useEffect, useCallback, useRef } from "react"
import { useCloud } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

// ─── Types ──────────────────────────────────────────────────────────────────────

type DeploymentStatus = "pending" | "running" | "success" | "failed" | "rolled_back"

interface Deployment {
  id: string
  projectId: string
  environment: string
  schemaHash: string
  status: DeploymentStatus
  startedAt: string
  finishedAt: string | null
  error: string | null
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
  return `${days}d ago`
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "..."
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

const STATUS_STYLES: Record<DeploymentStatus, { bg: string; text: string; dot: string; pulse?: boolean }> = {
  pending: { bg: "bg-yellow-500/10", text: "text-yellow-500", dot: "bg-yellow-500" },
  running: { bg: "bg-blue-500/10", text: "text-blue-500", dot: "bg-blue-500", pulse: true },
  success: { bg: "bg-green-500/10", text: "text-green-500", dot: "bg-green-500" },
  failed: { bg: "bg-red-500/10", text: "text-red-500", dot: "bg-red-500" },
  rolled_back: { bg: "bg-orange-500/10", text: "text-orange-500", dot: "bg-orange-500" },
}

function StatusBadge({ status }: { status: DeploymentStatus }): React.ReactElement {
  const style = STATUS_STYLES[status]
  const label = status === "rolled_back" ? "Rolled Back" : status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium", style.bg, style.text)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", style.dot, style.pulse && "animate-pulse")} />
      {label}
    </span>
  )
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function DeploymentHistory(): React.ReactElement {
  const cloud = useCloud()
  const { activeProject } = cloud
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDeployments = useCallback(async () => {
    if (!activeProject) return
    try {
      const res = await fetch(`/api/v1/projects/${activeProject.slug}/deployments`, {
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) throw new Error("Failed to fetch deployments")
      const json = (await res.json()) as { data: Deployment[] }
      setDeployments(json.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deployments")
    } finally {
      setLoading(false)
    }
  }, [activeProject])

  // Initial fetch
  useEffect(() => {
    setLoading(true)
    void fetchDeployments()
  }, [fetchDeployments])

  // Auto-refresh if any deployment is pending/running
  useEffect(() => {
    const hasActive = deployments.some((d) => d.status === "pending" || d.status === "running")
    if (hasActive) {
      intervalRef.current = setInterval(() => {
        void fetchDeployments()
      }, 5000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [deployments, fetchDeployments])

  const handleRollback = useCallback(async (deploymentId: string) => {
    if (!activeProject) return
    setRollingBack(deploymentId)
    try {
      const res = await fetch(`/api/v1/projects/${activeProject.slug}/deployments/${deploymentId}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) throw new Error("Rollback failed")
      await fetchDeployments()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed")
    } finally {
      setRollingBack(null)
    }
  }, [activeProject, fetchDeployments])

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Select a project to view deployments.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading deployments...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 bg-destructive/10 text-destructive rounded-md text-sm">
        {error}
      </div>
    )
  }

  if (deployments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground text-sm">
        <p>No deployments yet.</p>
        <p>
          Push your schema with <code className="bg-muted px-1.5 py-0.5 rounded text-foreground text-xs">supatype push</code> to create your first deployment.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Deployment History</h2>
        <button
          type="button"
          onClick={() => { setLoading(true); void fetchDeployments() }}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Environment</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Schema Hash</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Started</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Duration</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <StatusBadge status={d.status} />
                </td>
                <td className="px-4 py-3 text-foreground">{d.environment}</td>
                <td className="px-4 py-3">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                    {d.schemaHash.slice(0, 12)}
                  </code>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{relativeTime(d.startedAt)}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDuration(d.startedAt, d.finishedAt)}</td>
                <td className="px-4 py-3 text-right">
                  {d.status === "success" && (
                    <button
                      type="button"
                      disabled={rollingBack === d.id}
                      onClick={() => void handleRollback(d.id)}
                      className={cn(
                        "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                        rollingBack === d.id
                          ? "bg-muted text-muted-foreground cursor-not-allowed"
                          : "bg-orange-500/10 text-orange-500 hover:bg-orange-500/20",
                      )}
                    >
                      {rollingBack === d.id ? "Rolling back..." : "Rollback"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
