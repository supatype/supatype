import React, { useState, useEffect, useCallback } from "react"
import { useCloud, type CloudEnvironment } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

interface ProjectSettingsProps {
  onNavigate: (path: string) => void
}

export function ProjectSettings({ onNavigate }: ProjectSettingsProps): React.ReactElement {
  const { activeProject, pauseProject, resumeProject, deleteProject, getEnvironments } = useCloud()
  const [activeTab, setActiveTab] = useState<"general" | "keys" | "envvars" | "danger">("general")
  const [deleteConfirmation, setDeleteConfirmation] = useState("")
  const [deleting, setDeleting] = useState(false)

  // API Keys state
  const [environments, setEnvironments] = useState<CloudEnvironment[]>([])
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({})
  const [keysLoaded, setKeysLoaded] = useState(false)

  const loadEnvironments = useCallback(async () => {
    if (!activeProject) return
    try {
      const envs = await getEnvironments(activeProject.slug)
      setEnvironments(envs)
      setKeysLoaded(true)
    } catch {
      // Silent fail — keys tab will show loading
    }
  }, [activeProject, getEnvironments])

  useEffect(() => {
    if (activeTab === "keys" && !keysLoaded) {
      void loadEnvironments()
    }
  }, [activeTab, keysLoaded, loadEnvironments])

  if (!activeProject) {
    return <div className="text-muted-foreground text-sm">Select a project to view settings.</div>
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteProject(activeProject.slug, deleteConfirmation)
      onNavigate("/cloud/projects")
    } catch {
      // error handled by useCloud
    } finally {
      setDeleting(false)
    }
  }

  const toggleReveal = (keyId: string) => {
    setRevealedKeys((prev) => ({ ...prev, [keyId]: !prev[keyId] }))
  }

  const productionEnv = environments.find((e) => e.name === "production")

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Project Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">{activeProject.name}</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {(["general", "keys", "envvars", "danger"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "envvars" ? "Environment Variables" : tab === "danger" ? "Danger Zone" : tab === "keys" ? "API Keys" : "General"}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Project name</label>
              <div className="text-sm text-foreground">{activeProject.name}</div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Slug</label>
              <code className="text-sm text-foreground">{activeProject.slug}</code>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Tier</label>
              <div className="text-sm text-foreground capitalize">{activeProject.tier}</div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Region</label>
              <div className="text-sm text-foreground">{activeProject.region}</div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Status</label>
              <div className="text-sm text-foreground capitalize">{activeProject.status}</div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Created</label>
              <div className="text-sm text-foreground">{new Date(activeProject.createdAt).toLocaleDateString()}</div>
            </div>
          </div>

          {/* API URL */}
          {productionEnv && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">API URL</label>
              <code className="text-sm text-primary bg-primary/10 px-2 py-1 rounded">{productionEnv.apiUrl}</code>
            </div>
          )}
        </div>
      )}

      {activeTab === "keys" && (
        <div className="space-y-4">
          <div className="p-4 bg-card border border-border rounded-xl">
            <h3 className="text-sm font-medium text-foreground mb-3">API Keys</h3>
            <p className="text-xs text-muted-foreground mb-4">
              These keys are used to authenticate requests to your project&apos;s API.
            </p>
            {!keysLoaded ? (
              <div className="text-xs text-muted-foreground">Loading keys...</div>
            ) : productionEnv ? (
              <div className="space-y-3">
                <div className="p-3 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <div className="text-xs font-medium text-foreground">anon (public)</div>
                      <div className="text-[11px] text-muted-foreground">Safe to use in client-side code</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleReveal("anon")}
                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      {revealedKeys["anon"] ? "Hide" : "Reveal"}
                    </button>
                  </div>
                  {revealedKeys["anon"] && (
                    <code className="block mt-2 text-[11px] text-foreground bg-background p-2 rounded break-all select-all">
                      {productionEnv.anonKey}
                    </code>
                  )}
                </div>
                <div className="p-3 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <div className="text-xs font-medium text-foreground">service_role (secret)</div>
                      <div className="text-[11px] text-muted-foreground">Server-side only — never expose in client code</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleReveal("service_role")}
                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      {revealedKeys["service_role"] ? "Hide" : "Reveal"}
                    </button>
                  </div>
                  {revealedKeys["service_role"] && (
                    <code className="block mt-2 text-[11px] text-foreground bg-background p-2 rounded break-all select-all">
                      {productionEnv.serviceRoleKey}
                    </code>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No production environment found.</div>
            )}
          </div>
        </div>
      )}

      {activeTab === "envvars" && (
        <div className="p-8 text-center bg-card border border-border rounded-xl">
          <h3 className="text-sm font-medium text-foreground mb-2">Environment Variables</h3>
          <p className="text-xs text-muted-foreground">
            Custom environment variables for your project&apos;s services. Coming soon.
          </p>
        </div>
      )}

      {activeTab === "danger" && (
        <div className="space-y-4">
          {/* Pause/Resume */}
          <div className="p-4 bg-card border border-amber-500/30 rounded-xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  {activeProject.status === "paused" ? "Resume Project" : "Pause Project"}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {activeProject.status === "paused"
                    ? "Resume this project to make it accessible again."
                    : "Pause this project to stop all services. Your data will be preserved."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (activeProject.status === "paused") void resumeProject(activeProject.slug)
                  else void pauseProject(activeProject.slug)
                }}
                className={cn(
                  "px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                  activeProject.status === "paused"
                    ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                    : "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30",
                )}
              >
                {activeProject.status === "paused" ? "Resume" : "Pause"}
              </button>
            </div>
          </div>

          {/* Delete */}
          <div className="p-4 bg-card border border-red-500/30 rounded-xl">
            <h3 className="text-sm font-medium text-foreground mb-1">Delete Project</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Permanently delete this project and all its data. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={`Type "${activeProject.name}" to confirm`}
                className="flex-1 max-w-sm px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-red-500/50"
              />
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting || deleteConfirmation !== activeProject.name}
                className="px-4 py-2 bg-red-500 text-white text-sm font-medium rounded-lg hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? "Deleting..." : "Delete Project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
