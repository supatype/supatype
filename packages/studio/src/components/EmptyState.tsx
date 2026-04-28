import React from "react"

export interface EmptyStateProps {
  title: string
  description?: string
  action?: () => void
  actionLabel?: string
}

export function EmptyState({
  title,
  description,
  action,
  actionLabel,
}: EmptyStateProps): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center mb-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground"
        >
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M12 12h.01" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-foreground mb-1">{title}</h3>
      {description ? (
        <p className="text-xs text-muted-foreground max-w-[320px] mb-4">
          {description}
        </p>
      ) : null}
      {action && actionLabel ? (
        <button
          type="button"
          onClick={action}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}
