import React from "react"
import { useCloud, type Tier } from "../hooks/useCloud.js"

interface UpgradeBannerProps {
  /** The feature that requires an upgrade */
  feature: string
  /** Minimum tier required */
  requiredTier?: Tier
  /** Navigation callback to billing page */
  onNavigate: (path: string) => void
  /** Optional extra CSS class */
  className?: string
}

/**
 * Contextual upgrade banner shown inline when a feature requires a paid tier.
 * Appendix C, task 51.
 */
export function UpgradeBanner({
  feature,
  requiredTier = "pro",
  onNavigate,
  className = "",
}: UpgradeBannerProps): React.ReactElement | null {
  const { activeOrg } = useCloud()

  if (!activeOrg) return null

  const tierOrder: Record<Tier, number> = { free: 0, pro: 1, team: 2, enterprise: 3 }
  if (tierOrder[activeOrg.tier] >= tierOrder[requiredTier]) return null

  return (
    <div className={`p-3 bg-primary/5 border border-primary/20 rounded-lg flex items-center justify-between ${className}`}>
      <div className="text-sm text-foreground">
        <strong className="capitalize">{requiredTier}+</strong> plan required for {feature}.
      </div>
      <button
        type="button"
        onClick={() => onNavigate("/cloud/billing")}
        className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors shrink-0 ml-3"
      >
        Upgrade
      </button>
    </div>
  )
}

/**
 * Free tier limit reached banner.
 * Appendix C, tasks 16-17.
 */
export function FreeLimitBanner({
  resource,
  current,
  limit,
  onNavigate,
}: {
  resource: string
  current: number
  limit: number
  onNavigate: (path: string) => void
}): React.ReactElement | null {
  if (current < limit) return null

  return (
    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-between">
      <div className="text-sm text-foreground">
        You've reached the limit of {limit} {resource} on the free tier.
      </div>
      <button
        type="button"
        onClick={() => onNavigate("/cloud/billing")}
        className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors shrink-0 ml-3"
      >
        Upgrade
      </button>
    </div>
  )
}

/**
 * Usage warning banner shown when a resource exceeds 80% of its limit.
 * Appendix C, task 40.
 */
export function UsageWarningBanner({
  resource,
  usedMb,
  limitMb,
}: {
  resource: string
  usedMb: number
  limitMb: number
}): React.ReactElement | null {
  if (limitMb <= 0) return null

  const pct = (usedMb / limitMb) * 100
  if (pct < 80) return null

  const isOverage = pct >= 100

  return (
    <div className={`p-3 rounded-lg flex items-center gap-2 text-sm ${
      isOverage
        ? "bg-red-500/10 border border-red-500/20 text-red-400"
        : "bg-amber-500/10 border border-amber-500/20 text-amber-400"
    }`}>
      <span className="font-medium">
        {isOverage ? "Overage:" : "Warning:"}
      </span>
      {resource} usage is at {Math.round(pct)}% of your limit.
    </div>
  )
}
