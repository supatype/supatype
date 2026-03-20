import React, { useState } from "react"
import { useCloud, type CloudProject, type ProjectStatus, type Tier } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

const STATUS_COLORS: Record<ProjectStatus, string> = {
  provisioning: "bg-blue-500/20 text-blue-400",
  active: "bg-emerald-500/20 text-emerald-400",
  paused: "bg-amber-500/20 text-amber-400",
  error: "bg-red-500/20 text-red-400",
  deleting: "bg-red-500/20 text-red-400",
}

const TIER_LABELS: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
}

interface ProjectListProps {
  onNavigate: (path: string) => void
  onSelectProject: (project: CloudProject) => void
  onCreateProject: () => void
}

export function ProjectList({ onNavigate, onSelectProject, onCreateProject }: ProjectListProps): React.ReactElement {
  const { projects, loading, error, resumeProject, retryProject, organisations, activeOrg, setActiveOrg, createOrganisation } = useCloud()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all")
  const [showNewOrg, setShowNewOrg] = useState(false)
  const [newOrgName, setNewOrgName] = useState("")
  const [creatingOrg, setCreatingOrg] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const filtered = projects.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.slug.includes(search.toLowerCase())) return false
    if (statusFilter !== "all" && p.status !== statusFilter) return false
    return true
  })

  if (loading && projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground text-sm">Loading projects...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>
    )
  }

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return
    setCreatingOrg(true)
    setActionError(null)
    try {
      const org = await createOrganisation(newOrgName.trim())
      setActiveOrg(org)
      setShowNewOrg(false)
      setNewOrgName("")
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create organisation")
    } finally {
      setCreatingOrg(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Org switcher */}
      {organisations.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-muted-foreground">Organisation:</label>
          <select
            value={activeOrg?.id ?? ""}
            onChange={(e) => {
              const org = organisations.find((o) => o.id === e.target.value)
              if (org) setActiveOrg(org)
            }}
            className="px-3 py-1.5 text-sm bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {organisations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.tier})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowNewOrg(!showNewOrg)}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors"
          >
            + New Org
          </button>
        </div>
      )}

      {showNewOrg && (
        <div className="space-y-2">
          <div className="flex items-end gap-3 p-4 bg-card border border-border rounded-xl">
            <div className="flex-1">
              <label className="block text-sm font-medium text-foreground mb-1">New organisation name</label>
              <input
                type="text"
                value={newOrgName}
                onChange={(e) => { setNewOrgName(e.target.value); setActionError(null) }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleCreateOrg() }}
                placeholder="My Team"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => void handleCreateOrg()}
              disabled={creatingOrg || !newOrgName.trim()}
              className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creatingOrg ? "Creating..." : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setShowNewOrg(false); setNewOrgName(""); setActionError(null) }}
              className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
          {actionError && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{actionError}</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">{projects.length} project{projects.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          type="button"
          onClick={onCreateProject}
          className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          New Project
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-sm px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | "all")}
          className="px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="provisioning">Provisioning</option>
          <option value="error">Error</option>
        </select>
      </div>

      {/* Project grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {projects.length === 0 ? "No projects yet. Create your first project to get started." : "No projects match your filters."}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onSelect={() => onSelectProject(project)}
              onResume={() => void resumeProject(project.slug)}
              onRetry={() => void retryProject(project.slug)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  onSelect,
  onResume,
  onRetry,
}: {
  project: CloudProject
  onSelect: () => void
  onResume: () => void
  onRetry: () => void
}): React.ReactElement {
  const isPaused = project.status === "paused"
  const isProvisioning = project.status === "provisioning"
  const isError = project.status === "error"

  return (
    <button
      type="button"
      onClick={isPaused || isError ? undefined : onSelect}
      className={cn(
        "text-left p-5 bg-card border border-border rounded-xl transition-all",
        !isPaused && !isError && "hover:border-primary/50 hover:shadow-md cursor-pointer",
        (isPaused || isError) && "opacity-80",
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{project.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{project.slug}</p>
        </div>
        <span className={cn("px-2 py-0.5 text-[11px] font-medium rounded-full shrink-0 ml-2", STATUS_COLORS[project.status])}>
          {project.status}
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
        <span className="px-1.5 py-0.5 bg-muted rounded text-[11px]">{TIER_LABELS[project.tier]}</span>
        <span>{project.region}</span>
      </div>

      {/* Usage bars */}
      <div className="space-y-2">
        <UsageBar label="Database" used={project.dbSizeMb} limitMb={project.tier === "free" ? 500 : 8192} />
        <UsageBar label="Storage" used={project.storageSizeMb} limitMb={project.tier === "free" ? 1024 : 51200} />
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
        <span className="text-[11px] text-muted-foreground">
          Last active {formatRelativeTime(project.lastActivityAt)}
        </span>
        {isPaused && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResume() }}
            className="px-3 py-1 text-xs font-medium bg-amber-500/20 text-amber-400 rounded-md hover:bg-amber-500/30 transition-colors"
          >
            Resume
          </button>
        )}
        {isProvisioning && (
          <span className="text-[11px] text-blue-400 animate-pulse">Provisioning...</span>
        )}
        {isError && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry() }}
            className="px-3 py-1 text-xs font-medium bg-red-500/20 text-red-400 rounded-md hover:bg-red-500/30 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    </button>
  )
}

function UsageBar({ label, used, limitMb }: { label: string; used: number; limitMb: number }): React.ReactElement {
  const percent = limitMb > 0 ? Math.min((used / limitMb) * 100, 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{used} / {limitMb} MB</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", percent > 90 ? "bg-red-500" : percent > 70 ? "bg-amber-500" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
