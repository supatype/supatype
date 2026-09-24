"use client"

import React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { cn } from "../lib/utils.js"
import { NAV_RAIL } from "./ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem = {
  label: string
  href: string
  activeWhen?: (path: string) => boolean
  /**
   * Why this tab cannot be opened here, when it cannot.
   *
   * The tab stays and says so. Removing it leaves somebody concluding the product has no Postgres
   * logs, rather than that this build does not.
   */
  unavailable?: { note: string }
}
type NavGroup = { label?: string; items: NavItem[] }

// ─── Tertiary tab groups per route ────────────────────────────────────────────

function edgeFunctionsBaseFromPath(path: string): string | null {
  const match = path.match(/^\/edge-functions\/([^/]+)/)
  if (!match) return null
  return `/edge-functions/${match[1]}`
}

function getTertiaryGroups(path: string): NavGroup[] | null {
  // Observability: Logs
  if (path === "/observability/logs" || path.startsWith("/observability/logs/")) {
    return [{
      items: [
        { label: "API",            href: "/observability/logs/api",       activeWhen: (p) => p === "/observability/logs/api", unavailable: { note: "Request logging is not built yet" } },
        { label: "Auth",           href: "/observability/logs/auth",      activeWhen: (p) => p === "/observability/logs/auth" , unavailable: { note: "Auth event logging is not built yet" } },
        { label: "Storage",        href: "/observability/logs/storage",   activeWhen: (p) => p === "/observability/logs/storage" , unavailable: { note: "Storage access logging is not built yet" } },
        { label: "Edge Functions", href: "/observability/logs/functions", activeWhen: (p) => p === "/observability/logs/functions" },
        { label: "Realtime",       href: "/observability/logs/realtime",  activeWhen: (p) => p === "/observability/logs/realtime" , unavailable: { note: "Realtime connection logging is not built yet" } },
        { label: "Postgres",       href: "/observability/logs/postgres",  activeWhen: (p) => p === "/observability/logs/postgres" , unavailable: { note: "Database server logs are not built yet" } },
      ],
    }]
  }

  // REST API
  if (path === "/api/rest" || path.startsWith("/api/rest/")) {
    return [{
      items: [
        { label: "Docs",     href: "/api/rest" },
        { label: "Settings", href: "/api/rest/settings" },
        { label: "Cache",    href: "/api/rest/cache", activeWhen: (p) => p === "/api/rest/cache" },
      ],
    }]
  }

  // GraphQL
  if (path === "/api/graphql" || path.startsWith("/api/graphql/")) {
    return [{
      items: [
        { label: "Docs",     href: "/api/graphql" },
        { label: "Settings", href: "/api/graphql/settings" },
      ],
    }]
  }

  // Edge Functions
  if (path === "/edge-functions" || path.startsWith("/edge-functions/")) {
    const base = edgeFunctionsBaseFromPath(path)
    if (!base) return null
    return [{
      items: [
        {
          label: "Invoke",
          href: `${base}/invoke`,
          activeWhen: (p) => p.startsWith(base) && !p.endsWith("/logs") && !p.endsWith("/env"),
        },
        { label: "Logs", href: `${base}/logs`, activeWhen: (p) => p === `${base}/logs` },
        { label: "Environment Variables", href: `${base}/env`, activeWhen: (p) => p === `${base}/env` },
      ],
    }]
  }

  const storageMatch = path.match(/^\/media-storage\/([^/]+)\/(files|policies)$/)
  if (storageMatch) {
    const bucketSegment = storageMatch[1]
    const filesHref = `/media-storage/${bucketSegment}/files`
    const policiesHref = `/media-storage/${bucketSegment}/policies`
    return [{
      items: [
        { label: "Files", href: filesHref, activeWhen: (p) => p === filesHref },
        { label: "Policies", href: policiesHref, activeWhen: (p) => p === policiesHref },
      ],
    }]
  }

  // Intelligence: Agents sub-tabs
  if (path.startsWith("/ai/agents")) {
    return [{
      items: [
        { label: "List",       href: "/ai/agents/list",       activeWhen: (p) => p === "/ai/agents/list" },
        { label: "Runs",       href: "/ai/agents/runs",       activeWhen: (p) => p === "/ai/agents/runs" },
        { label: "Playground", href: "/ai/agents/playground", activeWhen: (p) => p === "/ai/agents/playground" },
      ],
    }]
  }

  // Singleton global (e.g. /models/globals/siteSettings)
  const globalMatch = path.match(/^\/models\/globals\/([^/]+)/)
  if (globalMatch) {
    const base = `/models/globals/${globalMatch[1]}`
    return [{
      items: [
        {
          label: "Editor",
          href: base,
          activeWhen: (p) =>
            p === base ||
            (p.startsWith(base + "/") &&
              !p.startsWith(base + "/schema") &&
              !p.startsWith(base + "/rules") &&
              !p.startsWith(base + "/data") &&
              !p.startsWith(base + "/api") &&
              !p.startsWith(base + "/graphql") &&
              !p.startsWith(base + "/cache")),
        },
        {
          label: "Schema",
          href: `${base}/schema`,
          activeWhen: (p) => p === `${base}/schema`,
        },
        {
          label: "Data",
          href: `${base}/data`,
          activeWhen: (p) => p === `${base}/data`,
        },
        {
          label: "API",
          href: `${base}/api`,
          activeWhen: (p) => p === `${base}/api`,
        },
        {
          label: "GraphQL",
          href: `${base}/graphql`,
          activeWhen: (p) => p === `${base}/graphql`,
        },
        {
          label: "Cache",
          href: `${base}/cache`,
          activeWhen: (p) => p === `${base}/cache`,
        },
      ],
    }]
  }

  // Collection model (extract base route, e.g. /models/post)
  const modelMatch = path.match(/^\/models\/([^/]+)/)
  if (modelMatch) {
    const base = `/models/${modelMatch[1]}`
    return [{
      items: [
        {
          label: "Editor",
          href: base,
          activeWhen: (p) =>
            p === base ||
            (p.startsWith(base + "/") &&
              !p.startsWith(base + "/schema") &&
              !p.startsWith(base + "/rules") &&
              !p.startsWith(base + "/data") &&
              !p.startsWith(base + "/api") &&
              !p.startsWith(base + "/graphql") &&
              !p.startsWith(base + "/cache")),
        },
        {
          label: "Schema",
          href: `${base}/schema`,
          activeWhen: (p) => p === `${base}/schema`,
        },
        {
          label: "Rules",
          href: `${base}/rules`,
          activeWhen: (p) => p === `${base}/rules`,
        },
        {
          label: "Data",
          href: `${base}/data`,
          activeWhen: (p) => p === `${base}/data`,
        },
        {
          label: "API",
          href: `${base}/api`,
          activeWhen: (p) => p === `${base}/api`,
        },
        {
          label: "GraphQL",
          href: `${base}/graphql`,
          activeWhen: (p) => p === `${base}/graphql`,
        },
        {
          label: "Cache",
          href: `${base}/cache`,
          activeWhen: (p) => p === `${base}/cache`,
        },
      ],
    }]
  }

  return null
}

// ─── TertiaryNav ──────────────────────────────────────────────────────────────

/**
 * Tier 3, the sub-tabs within a section item.
 *
 * `leading` is how the section-panel toggle reaches this rail on small screens. It is rendered
 * even on routes with no tabs, because the rail is the only place that toggle lives: returning
 * null there would leave a phone with the panel closed and no way to reopen it.
 */
export function TertiaryNav({
  leading,
}: {
  leading?: React.ReactNode
} = {}): React.ReactElement | null {
  const location = useLocation()
  const navigate = useNavigate()
  const path = location.pathname

  const groups = getTertiaryGroups(path)
  if (!groups) {
    if (!leading) return null
    return (
      <nav className={cn(NAV_RAIL, "bg-background md:hidden")} aria-label="Section navigation">
        <div className="flex items-center h-full px-2">{leading}</div>
      </nav>
    )
  }

  return (
    <nav
      className={cn(NAV_RAIL, "bg-background overflow-x-auto")}
      style={{ scrollbarWidth: "none" }}
      aria-label="Sub-section navigation"
    >
      <div className="flex items-center h-full px-2 md:px-4 gap-0.5 min-w-max">
        {leading}
        {groups.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <div className="mx-3 h-4 w-px bg-border shrink-0" />}
            {group.label && (
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mr-1.5">
                {group.label}
              </span>
            )}
            {group.items.map((item) => {
              const active = item.activeWhen ? item.activeWhen(path) : path === item.href
              if (item.unavailable !== undefined) {
                // Disabled rather than absent. A tab that vanishes teaches nothing: somebody looking
                // for Postgres logs concludes there are none, rather than that they are not built.
                return (
                  <span
                    key={item.href}
                    title={item.unavailable.note}
                    aria-disabled="true"
                    className={cn(
                      "relative h-10 px-3 text-[13px] whitespace-nowrap flex items-center",
                      "text-muted-foreground/50 cursor-not-allowed select-none",
                    )}
                  >
                    {item.label}
                  </span>
                )
              }
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigate(item.href)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative h-10 px-3 text-[13px] transition-colors whitespace-nowrap",
                    active
                      ? "text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                  )}
                </button>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </nav>
  )
}
