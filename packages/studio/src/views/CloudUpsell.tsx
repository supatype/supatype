import React from "react"
import { useCloudUrl } from "../hooks/useCloudUrl.js"
import { cn } from "../lib/utils.js"

export interface CloudUpsellProps {
  /** Feature name, e.g. "Realtime Inspector" */
  title: string
  /** One-sentence pitch for the feature */
  description: string
  /** Bullet-point capabilities shown as a feature list */
  features: string[]
  /** Optional override for the cloud URL (falls back to context value) */
  cloudUrl?: string
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-primary mt-0.5"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function CloudIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-primary"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  )
}

export function CloudUpsell({ title, description, features, cloudUrl: propCloudUrl }: CloudUpsellProps): React.ReactElement {
  const ctxCloudUrl = useCloudUrl()
  const cloudUrl = propCloudUrl ?? ctxCloudUrl

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-full max-w-[440px]">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <CloudIcon />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <span className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
              "bg-primary/10 text-primary",
            )}>
              Cloud
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        {/* Feature list */}
        <div className="bg-card border border-border rounded-lg p-4 mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            What you get
          </p>
          <ul className="space-y-2.5">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <CheckIcon />
                <span className="text-sm text-foreground">{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* CTA */}
        {cloudUrl ? (
          <a
            href={cloudUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center justify-center w-full px-4 py-2.5 rounded-md text-sm font-medium transition-colors",
              "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Try Supatype Cloud
          </a>
        ) : (
          <div className="text-center text-xs text-muted-foreground">
            Available on Supatype Cloud
          </div>
        )}
      </div>
    </div>
  )
}
