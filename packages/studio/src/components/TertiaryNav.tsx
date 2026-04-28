"use client"

import React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { cn } from "../lib/utils.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem = { label: string; href: string; activeWhen?: (path: string) => boolean }
type NavGroup = { label?: string; items: NavItem[] }

// ─── Tertiary tab groups per route ────────────────────────────────────────────

function getTertiaryGroups(path: string): NavGroup[] | null {
  // Observability — Logs
  if (path === "/observability/logs" || path.startsWith("/observability/logs/")) {
    return [{
      items: [
        { label: "API",            href: "/observability/logs/api",       activeWhen: (p) => p === "/observability/logs/api" },
        { label: "Auth",           href: "/observability/logs/auth",      activeWhen: (p) => p === "/observability/logs/auth" },
        { label: "Storage",        href: "/observability/logs/storage",   activeWhen: (p) => p === "/observability/logs/storage" },
        { label: "Edge Functions", href: "/observability/logs/functions", activeWhen: (p) => p === "/observability/logs/functions" },
        { label: "Realtime",       href: "/observability/logs/realtime",  activeWhen: (p) => p === "/observability/logs/realtime" },
        { label: "Postgres",       href: "/observability/logs/postgres",  activeWhen: (p) => p === "/observability/logs/postgres" },
      ],
    }]
  }

  // REST API
  if (path === "/api/rest" || path.startsWith("/api/rest/")) {
    return [{
      items: [
        { label: "Docs",     href: "/api/rest" },
        { label: "Settings", href: "/api/rest/settings" },
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

  // Intelligence — Agents sub-tabs
  if (path.startsWith("/ai/agents")) {
    return [{
      items: [
        { label: "List",       href: "/ai/agents/list",       activeWhen: (p) => p === "/ai/agents/list" },
        { label: "Runs",       href: "/ai/agents/runs",       activeWhen: (p) => p === "/ai/agents/runs" },
        { label: "Playground", href: "/ai/agents/playground", activeWhen: (p) => p === "/ai/agents/playground" },
      ],
    }]
  }

  // Model (extract base route, e.g. /models/post)
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
              !p.startsWith(base + "/data") &&
              !p.startsWith(base + "/api") &&
              !p.startsWith(base + "/graphql")),
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
      ],
    }]
  }

  return null
}

// ─── TertiaryNav ──────────────────────────────────────────────────────────────

export function TertiaryNav(): React.ReactElement | null {
  const location = useLocation()
  const navigate = useNavigate()
  const path = location.pathname

  const groups = getTertiaryGroups(path)
  if (!groups) return null

  return (
    <nav
      className="shrink-0 border-b border-border/80 bg-background overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
      aria-label="Sub-section navigation"
    >
      <div className="flex items-center h-10 px-4 gap-0.5 min-w-max">
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
