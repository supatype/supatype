import React from "react"
import { CodeBlock } from "./ui.js"

export interface ErrorBannerProps {
  message: string
  /** The server's own text behind a plain message, shown on request rather than in its place. */
  details?: string | null | undefined
  onRetry?: () => void
}

export function ErrorBanner({ message, details, onRetry }: ErrorBannerProps): React.ReactElement {
  return (
    <div data-ui="error-banner" role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 space-y-2">
      <div className="flex items-center gap-3">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-destructive shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span data-ui="error-banner-message" className="text-sm text-destructive flex-1">{message}</span>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="px-2.5 py-1 text-xs font-medium rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0"
          >
            Retry
          </button>
        ) : null}
      </div>
      {details ? <ErrorDetails details={details} /> : null}
    </div>
  )
}

/** The server's wording, folded away: plain words lead, the raw text is there for whoever needs it. */
function ErrorDetails({ details }: { details: string }): React.ReactElement {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Details</summary>
      <CodeBlock className="mt-2 p-2 text-[0.7rem] whitespace-pre-wrap">{details}</CodeBlock>
    </details>
  )
}
