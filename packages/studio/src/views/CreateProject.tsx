import React, { useState } from "react"
import { useCloud, type Tier } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

interface CreateProjectProps {
  onNavigate: (path: string) => void
  onCreated: () => void
  onCancel: () => void
}

const TIERS: Array<{ value: Tier; label: string; price: string; features: string[] }> = [
  {
    value: "free",
    label: "Free",
    price: "0",
    features: ["500MB database", "1GB storage", "5GB bandwidth", "2 active projects"],
  },
  {
    value: "pro",
    label: "Pro",
    price: "25",
    features: ["8GB database", "50GB storage", "50GB bandwidth", "10 projects", "Daily backups", "Custom domain"],
  },
  {
    value: "team",
    label: "Team",
    price: "75",
    features: ["50GB database", "500GB storage", "Unlimited bandwidth", "Unlimited projects", "Hourly backups + PITR", "99.9% SLA"],
  },
]

const REGIONS = [
  { value: "eu-fsn", label: "EU (Falkenstein)" },
  { value: "eu-nbg", label: "EU (Nuremberg)" },
  { value: "eu-hel", label: "EU (Helsinki)" },
]

export function CreateProject({ onNavigate, onCreated, onCancel }: CreateProjectProps): React.ReactElement {
  const { createProject } = useCloud()
  const [name, setName] = useState("")
  const [tier, setTier] = useState<Tier>("free")
  const [region, setRegion] = useState("eu-fsn")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Project name is required")
      return
    }
    setCreating(true)
    setError(null)
    try {
      await createProject(name.trim(), tier, region)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          &larr; Back to projects
        </button>
        <h1 className="text-2xl font-bold text-foreground">Create a new project</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Set up a new Supatype project with its own database and services.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>
      )}

      {/* Project name */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Project name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Awesome App"
          className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          autoFocus
        />
      </div>

      {/* Tier selection */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-3">Plan</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {TIERS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTier(t.value)}
              className={cn(
                "text-left p-4 border rounded-xl transition-all",
                tier === t.value
                  ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30",
              )}
            >
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-semibold text-foreground">{t.label}</span>
                <span className="text-xs text-muted-foreground">
                  {t.price === "0" ? "Free" : `\u00A3${t.price}/mo`}
                </span>
              </div>
              <ul className="space-y-1">
                {t.features.map((f) => (
                  <li key={f} className="text-[11px] text-muted-foreground">{f}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </div>

      {/* Region */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Region</label>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* Create button */}
      <div className="flex gap-3 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          className="px-6 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {creating ? "Creating..." : "Create Project"}
        </button>
      </div>
    </div>
  )
}
