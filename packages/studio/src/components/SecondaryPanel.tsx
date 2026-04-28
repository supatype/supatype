"use client"

import React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { AdminConfigContext } from "../hooks/useAdminConfig.js"
import type { AdminConfig } from "../config.js"
import { cn } from "../lib/utils.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem = { label: string; href: string }
type NavGroup = { label?: string; items: NavItem[] }
type SectionDef = { title: string; groups: NavGroup[] }

// ─── Static section definitions ───────────────────────────────────────────────

const STATIC_SECTIONS: Record<string, SectionDef> = {
  database: {
    title: "Database",
    groups: [
      {
        items: [
          { label: "Overview",   href: "/database/overview" },
          { label: "Tables",     href: "/database/tables" },
          { label: "Views",      href: "/database/views" },
          { label: "Functions",  href: "/database/functions" },
          { label: "Triggers",   href: "/database/triggers" },
          { label: "Types",      href: "/database/types" },
          { label: "Roles",      href: "/database/roles" },
          { label: "Extensions", href: "/database/extensions" },
        ],
      },
      {
        label: "Tools",
        items: [
          { label: "SQL Runner",  href: "/database/sql" },
          { label: "Migrations",  href: "/database/migrations" },
        ],
      },
      {
        label: "Coming Soon",
        items: [
          { label: "Wrappers",    href: "/database/wrappers" },
          { label: "Replication", href: "/database/replication" },
          { label: "Warehouse",   href: "/database/warehouse" },
          { label: "Backups",     href: "/database/backups" },
        ],
      },
    ],
  },
  settings: {
    title: "Settings",
    groups: [
      {
        items: [
          { label: "General", href: "/settings" },
        ],
      },
      {
        label: "API",
        items: [
          { label: "REST", href: "/api/rest" },
          { label: "GraphQL", href: "/api/graphql" },
        ],
      },
    ],
  },
  auth: {
    title: "Authentication",
    groups: [
      {
        items: [
          { label: "Users",            href: "/authentication/users" },
          { label: "Policies",         href: "/authentication/policies" },
          { label: "Providers",        href: "/authentication/providers" },
          { label: "Configuration",    href: "/authentication/configuration" },
          { label: "Email Templates",  href: "/authentication/email-templates" },
        ],
      },
      {
        label: "Coming Soon",
        items: [
          { label: "Hooks",    href: "/authentication/hooks" },
          { label: "SSO",      href: "/authentication/sso" },
          { label: "Security", href: "/authentication/security" },
        ],
      },
    ],
  },
  storage: {
    title: "Media & Storage",
    groups: [{
      items: [
        { label: "Files",    href: "/media-storage" },
        { label: "Policies", href: "/media-storage/policies" },
      ],
    }],
  },
  observability: {
    title: "Observability",
    groups: [{
      items: [
        { label: "Logs",     href: "/observability/logs" },
        { label: "Metrics",  href: "/observability/metrics" },
        { label: "Advisors", href: "/observability/advisors" },
      ],
    }],
  },
  ai: {
    title: "Intelligence",
    groups: [{
      items: [
        { label: "Usage",   href: "/ai/usage" },
        { label: "Vectors", href: "/ai/vectors" },
        { label: "RAG",     href: "/ai/rag" },
        { label: "Agents",  href: "/ai/agents/list" },
      ],
    }],
  },
}

// ─── Section detection ────────────────────────────────────────────────────────

function getSectionId(path: string): string | null {
  if (path === "/models" || path.startsWith("/models/")) return "models"
  if (path.startsWith("/api") || path === "/settings" || path.startsWith("/settings/")) return "settings"
  if (path.startsWith("/database")) return "database"
  if (path.startsWith("/authentication")) return "auth"
  if (path.startsWith("/media-storage")) return "storage"
  if (path.startsWith("/observability")) return "observability"
  if (path.startsWith("/ai")) return "ai"
  return null
}

// ─── SecondaryPanel ───────────────────────────────────────────────────────────

export function SecondaryPanel(): React.ReactElement | null {
  const location = useLocation()
  const navigate = useNavigate()
  const config = React.useContext(AdminConfigContext)
  const path = location.pathname

  const sectionId = getSectionId(path)
  if (!sectionId) return null

  let section: SectionDef
  if (sectionId === "models") {
    const items = (config?.models ?? []).map((m) => ({
      label: m.labelPlural,
      href: `/models/${m.name}`,
    }))
    section = {
      title: "Models",
      groups: items.length > 0
        ? [{ items }]
        : [{ items: [{ label: "No models yet", href: "/models" }] }],
    }
  } else {
    section = STATIC_SECTIONS[sectionId] ?? { title: "", groups: [] }
  }

  return (
    <div className="w-[200px] shrink-0 border-r border-border/80 bg-background flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 pb-2.5 border-b border-border/50">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {section.title}
        </h2>
      </div>
      <nav className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: "none" }}>
        {section.groups.map((group, gi) => (
          <div key={gi} className={cn(gi > 0 && "mt-3")}>
            {group.label && (
              <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              // An item is active if the path matches or starts with it,
              // but for model items we exclude the /schema sub-route so
              // the Editor tab (not Schema tab) stays highlighted here.
              const active =
                path === item.href ||
                path.startsWith(item.href + "/") ||
                path.startsWith(item.href + "?")
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigate(item.href)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center w-full px-4 py-1.5 text-[13px] transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    active
                      ? "text-foreground font-medium bg-accent/50"
                      : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </div>
  )
}
