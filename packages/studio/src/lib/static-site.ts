import { formatBytes } from "./cache-health.js"
import type { StaticSiteHost, StaticSiteMode } from "./static-site-host.js"

/** The Static site group's pages, as paths in Studio. */
export const STATIC_SITE_PATHS = {
  overview: "/static-site",
  settings: "/static-site/settings",
  deployments: "/static-site/deployments",
} as const

export interface StaticSitePage {
  label: string
  href: string
}

/**
 * The pages this host's group has, in nav order. Deployments is in the list only when the host
 * provides one, which is how Cloud gets it and self-host does not.
 */
export function staticSitePages(host: Pick<StaticSiteHost, "Deployments">): StaticSitePage[] {
  return [
    { label: "Overview", href: STATIC_SITE_PATHS.overview },
    ...(host.Deployments !== undefined ? [{ label: "Deployments", href: STATIC_SITE_PATHS.deployments }] : []),
    { label: "Settings", href: STATIC_SITE_PATHS.settings },
  ]
}

const MODE_LABEL: Record<StaticSiteMode, string> = {
  none: "Nothing",
  static: "Static files",
  proxy: "Proxy to another server",
}

export function modeLabel(mode: StaticSiteMode): string {
  return MODE_LABEL[mode]
}

/** A byte count for a page; "Not counted" when the host does not count (a proxy has no files). */
export function sizeText(bytes: number | null): string {
  return bytes === null ? "Not counted" : formatBytes(bytes)
}
