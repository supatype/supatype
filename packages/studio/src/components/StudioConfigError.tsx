"use client"

import React from "react"
import type { AdminConfig } from "../config.js"

export type StudioConfigErrorKind = "network" | "not_pushed" | "unknown"

export interface StudioConfigErrorProps {
  kind: StudioConfigErrorKind
  /** API base shown in copy (e.g. http://localhost:18473) */
  baseUrl: string
  message?: string
  onRetry: () => void
  /** Self-host: load bundled demo AdminConfig. Omit on cloud (use Retry only). */
  onTryDemo?: (config: AdminConfig) => void
  demoConfig?: AdminConfig
}

export function StudioConfigError({
  kind,
  baseUrl,
  message,
  onRetry,
  onTryDemo,
  demoConfig,
}: StudioConfigErrorProps): React.ReactElement {
  const title =
    kind === "network"
      ? "Cannot reach Studio config API"
      : kind === "not_pushed"
        ? "No schema has been pushed yet"
        : "Could not load Studio config"

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12 text-center">
      <div className="max-w-md space-y-4">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {kind === "network" && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            Nothing responded at <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{baseUrl}</code>.
            Start your stack (<code className="rounded bg-muted px-1.5 py-0.5 text-xs">supatype dev</code>), check
            Docker, and confirm <code className="rounded bg-muted px-1.5 py-0.5 text-xs">VITE_SUPATYPE_URL</code> if
            you use a custom URL.
          </p>
        )}
        {kind === "not_pushed" && (
          <ol className="text-left text-sm text-muted-foreground space-y-2 list-decimal list-inside">
            <li>Define your schema in your Supatype schema file.</li>
            <li>
              Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">supatype push</code> so the engine can
              store AdminConfig.
            </li>
            <li>Refresh this page.</li>
          </ol>
        )}
        {kind === "unknown" && message && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{message}</p>
        )}
        <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Retry
          </button>
          {onTryDemo != null && demoConfig != null && (
            <button
              type="button"
              onClick={() => onTryDemo(demoConfig)}
              className="inline-flex items-center justify-center rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-accent"
            >
              Explore with sample data
            </button>
          )}
        </div>
        {onTryDemo != null && (
          <p className="text-xs text-muted-foreground pt-2">
            Demo mode uses a sample blog config and is labeled in the top bar. Clear{" "}
            <code className="rounded bg-muted px-1">sessionStorage</code> or use a private window to exit.
          </p>
        )}
      </div>
    </div>
  )
}
