import React from "react"
import { useCloud, type Tier } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

const TIER_LIMITS: Record<Tier, { db: number; storage: number; bandwidth: number; apiRequests: number }> = {
  free: { db: 500, storage: 1024, bandwidth: 5120, apiRequests: 100_000 },
  pro: { db: 8192, storage: 51200, bandwidth: 51200, apiRequests: 2_000_000 },
  team: { db: 51200, storage: 512000, bandwidth: 512000, apiRequests: -1 },
  enterprise: { db: -1, storage: -1, bandwidth: -1, apiRequests: -1 },
}

export function UsageDashboard(): React.ReactElement {
  const { activeProject } = useCloud()

  if (!activeProject) {
    return <div className="text-muted-foreground text-sm">Select a project to view usage.</div>
  }

  const limits = TIER_LIMITS[activeProject.tier]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Resource consumption for <strong>{activeProject.name}</strong>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UsageCard
          title="Database"
          usedMb={activeProject.dbSizeMb}
          limitMb={limits.db}
          unit="MB"
        />
        <UsageCard
          title="Storage"
          usedMb={activeProject.storageSizeMb}
          limitMb={limits.storage}
          unit="MB"
        />
        <UsageCard
          title="Bandwidth"
          usedMb={activeProject.bandwidthUsedMb}
          limitMb={limits.bandwidth}
          unit="MB"
        />
        <UsageCard
          title="API Requests"
          usedMb={Number(activeProject.apiRequestCount)}
          limitMb={limits.apiRequests}
          unit=""
        />
      </div>

      {/* Overage info for Pro+ */}
      {activeProject.tier !== "free" && (
        <div className="p-4 bg-card border border-border rounded-lg">
          <h3 className="text-sm font-medium text-foreground mb-2">Overage Pricing</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-muted-foreground">
            <div><span className="font-medium text-foreground">Database:</span> {"\u00A3"}0.125/GB</div>
            <div><span className="font-medium text-foreground">Storage:</span> {"\u00A3"}0.02/GB</div>
            <div><span className="font-medium text-foreground">Bandwidth:</span> {"\u00A3"}0.09/GB</div>
            <div><span className="font-medium text-foreground">MAU:</span> {"\u00A3"}0.00325/user</div>
          </div>
        </div>
      )}
    </div>
  )
}

function UsageCard({
  title,
  usedMb,
  limitMb,
  unit,
}: {
  title: string
  usedMb: number
  limitMb: number
  unit: string
}): React.ReactElement {
  const unlimited = limitMb === -1
  const percent = unlimited ? 0 : Math.min((usedMb / limitMb) * 100, 100)
  const isOverage = !unlimited && usedMb > limitMb

  const formatValue = (val: number) => {
    if (unit === "MB" && val >= 1024) return `${(val / 1024).toFixed(1)} GB`
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
    return `${val}${unit ? ` ${unit}` : ""}`
  }

  return (
    <div className="p-4 bg-card border border-border rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {isOverage && (
          <span className="px-2 py-0.5 text-[11px] font-medium bg-red-500/20 text-red-400 rounded-full">
            Overage
          </span>
        )}
      </div>

      <div className="text-2xl font-bold text-foreground mb-1">
        {formatValue(usedMb)}
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        {unlimited ? "Unlimited" : `of ${formatValue(limitMb)} limit`}
      </div>

      {!unlimited && (
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              isOverage ? "bg-red-500" : percent > 90 ? "bg-amber-500" : percent > 70 ? "bg-amber-400" : "bg-primary",
            )}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}
