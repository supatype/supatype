import React, { useState } from "react"
import { useCloud, type Tier } from "../hooks/useCloud.js"

interface TierInfo {
  name: string
  price: string
  priceNote: string
  features: string[]
  highlighted: boolean
}

const TIERS: Record<string, TierInfo> = {
  free: {
    name: "Free",
    price: "£0",
    priceNote: "/month",
    features: [
      "500 MB database",
      "1 GB file storage",
      "5 GB bandwidth",
      "100K API requests",
      "2 projects",
      "Shared Postgres",
      "Community support",
    ],
    highlighted: false,
  },
  pro: {
    name: "Pro",
    price: "£25",
    priceNote: "/month per org",
    features: [
      "8 GB database",
      "100 GB file storage",
      "250 GB bandwidth",
      "2M API requests",
      "Unlimited projects",
      "Dedicated Postgres",
      "Daily backups",
      "Custom domains",
      "Email support",
    ],
    highlighted: true,
  },
  team: {
    name: "Team",
    price: "£599",
    priceNote: "/month per org",
    features: [
      "50 GB database",
      "500 GB file storage",
      "500 GB bandwidth",
      "Unlimited API requests",
      "Unlimited projects",
      "Dedicated Postgres",
      "Point-in-time recovery",
      "Custom domains",
      "SOC2 compliance",
      "Priority support",
      "SSO / SAML",
    ],
    highlighted: false,
  },
}

interface BillingPageProps {
  onNavigate: (path: string) => void
}

export function BillingPage({ onNavigate }: BillingPageProps): React.ReactElement {
  const { activeOrg, subscribe, cancelSubscription, getBillingPortalUrl } = useCloud()
  const [upgradeLoading, setUpgradeLoading] = useState<string | null>(null)
  const [cancelLoading, setCancelLoading] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  if (!activeOrg) {
    return <div className="text-muted-foreground text-sm">Loading...</div>
  }

  const currentTier = activeOrg.tier
  const hasSubscription = !!activeOrg.stripeSubscriptionId

  const handleUpgrade = async (tier: "pro" | "team") => {
    setUpgradeLoading(tier)
    setError(null)
    try {
      await subscribe(tier)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upgrade")
    } finally {
      setUpgradeLoading(null)
    }
  }

  const handleCancel = async () => {
    setCancelLoading(true)
    setError(null)
    try {
      await cancelSubscription()
      setShowCancelConfirm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel")
    } finally {
      setCancelLoading(false)
    }
  }

  const handlePortal = async () => {
    setPortalLoading(true)
    setError(null)
    try {
      const url = await getBillingPortalUrl(window.location.href)
      window.location.href = url
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal")
      setPortalLoading(false)
    }
  }

  const tierOrder: Record<Tier, number> = { free: 0, pro: 1, team: 2, enterprise: 3 }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your subscription and billing for <strong>{activeOrg.name}</strong>
        </p>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>
      )}

      {/* Current plan summary */}
      <div className="p-4 bg-card border border-border rounded-xl flex items-center justify-between">
        <div>
          <div className="text-sm text-muted-foreground">Current plan</div>
          <div className="text-xl font-bold text-foreground capitalize mt-1">{currentTier}</div>
          {hasSubscription && (
            <div className="text-xs text-muted-foreground mt-1">Active subscription via Stripe</div>
          )}
        </div>
        {hasSubscription && (
          <button
            type="button"
            onClick={() => void handlePortal()}
            disabled={portalLoading}
            className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {portalLoading ? "Opening..." : "Manage in Stripe"}
          </button>
        )}
      </div>

      {/* Plan comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(["free", "pro", "team"] as const).map((tierKey) => {
          const tier = TIERS[tierKey]!
          const isCurrent = currentTier === tierKey
          const isUpgrade = tierOrder[tierKey] > tierOrder[currentTier]
          const isDowngrade = tierOrder[tierKey] < tierOrder[currentTier]

          return (
            <div
              key={tierKey}
              className={`p-5 rounded-xl border ${
                tier.highlighted
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card"
              } ${isCurrent ? "ring-2 ring-primary/50" : ""}`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold text-foreground">{tier.name}</h3>
                {isCurrent && (
                  <span className="px-2 py-0.5 text-[11px] font-medium bg-primary/20 text-primary rounded-full">
                    Current
                  </span>
                )}
              </div>
              <div className="mb-4">
                <span className="text-3xl font-bold text-foreground">{tier.price}</span>
                <span className="text-sm text-muted-foreground">{tier.priceNote}</span>
              </div>

              <ul className="space-y-2 mb-6">
                {tier.features.map((f) => (
                  <li key={f} className="text-sm text-muted-foreground flex items-start gap-2">
                    <span className="text-primary mt-0.5 shrink-0">-</span>
                    {f}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <button
                  type="button"
                  disabled
                  className="w-full px-4 py-2 text-sm font-medium bg-muted text-muted-foreground rounded-lg cursor-not-allowed"
                >
                  Current plan
                </button>
              ) : isUpgrade ? (
                <button
                  type="button"
                  onClick={() => void handleUpgrade(tierKey as "pro" | "team")}
                  disabled={upgradeLoading !== null}
                  className="w-full px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {upgradeLoading === tierKey ? "Upgrading..." : `Upgrade to ${tier.name}`}
                </button>
              ) : isDowngrade ? (
                <button
                  type="button"
                  onClick={() => setShowCancelConfirm(true)}
                  className="w-full px-4 py-2 text-sm font-medium bg-card border border-border text-foreground rounded-lg hover:bg-accent transition-colors"
                >
                  Downgrade to {tier.name}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* Cancel confirmation */}
      {showCancelConfirm && (
        <div className="p-4 bg-destructive/5 border border-destructive/20 rounded-xl space-y-3">
          <h3 className="text-sm font-medium text-foreground">Cancel subscription?</h3>
          <p className="text-sm text-muted-foreground">
            Your projects will be downgraded to the free tier at the end of the current billing period.
            Projects exceeding free tier limits may be paused.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={cancelLoading}
              className="px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 disabled:opacity-50 transition-colors"
            >
              {cancelLoading ? "Cancelling..." : "Yes, cancel subscription"}
            </button>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(false)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border text-foreground rounded-lg hover:bg-accent transition-colors"
            >
              Keep my plan
            </button>
          </div>
        </div>
      )}

      {/* Usage link */}
      <div className="p-4 bg-card border border-border rounded-xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-foreground">Usage & Limits</h3>
            <p className="text-xs text-muted-foreground mt-1">View your resource consumption and tier limits</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("/cloud/usage")}
            className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg text-foreground hover:bg-accent transition-colors"
          >
            View usage
          </button>
        </div>
      </div>
    </div>
  )
}
