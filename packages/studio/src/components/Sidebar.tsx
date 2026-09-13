"use client"

import React, { useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import type { AdminConfig } from "../config.js"
import type { SidebarSection } from "../types.js"
import { cn } from "../lib/utils.js"
import { Icon, IconChevronRight, IconSettings } from "./icons.js"

// ─── Nav definition ───────────────────────────────────────────────────────────

interface NavItemDef {
  id: string
  label: string
  icon: string
  href: string
}

type NavEntry = NavItemDef | "separator"

const PRIMARY_NAV_ENTRIES: NavItemDef[] = [
  { id: "dashboard",     label: "Dashboard",        icon: "home",      href: "/" },
  { id: "models",        label: "Models",            icon: "grid",      href: "/models" },
]

const SECONDARY_NAV_ENTRIES: NavEntry[] = [
  { id: "database",      label: "Database",          icon: "database",  href: "/database/overview" },
  { id: "media",         label: "Media & Storage",   icon: "image",     href: "/media-storage" },
  "separator",
  { id: "auth",          label: "Authentication",    icon: "users",     href: "/authentication/users" },
  { id: "email",         label: "Email",             icon: "mail",      href: "/email" },
  "separator",
  { id: "functions",     label: "Edge Functions",    icon: "zap",       href: "/edge-functions" },
  { id: "realtime",      label: "Realtime",          icon: "radio",     href: "/realtime" },
  { id: "webhooks",      label: "Webhooks",          icon: "globe",     href: "/webhooks" },
  { id: "jobs",          label: "Scheduled Jobs",    icon: "clock",     href: "/jobs" },
  "separator",
  { id: "ai",            label: "Intelligence",      icon: "cpu",       href: "/ai/usage" },
  { id: "commerce",      label: "Commerce",          icon: "cart",      href: "/commerce" },
  { id: "analytics",     label: "Analytics",         icon: "barchart",  href: "/analytics" },
  "separator",
  { id: "plugins",       label: "Plugins",           icon: "plug",      href: "/plugins" },
  { id: "branching",     label: "Branching",         icon: "branch",    href: "/branching" },
  { id: "integrations",  label: "Integrations",      icon: "link",      href: "/integrations" },
  "separator",
  { id: "observability", label: "Observability",     icon: "eye",       href: "/observability" },
]

// ─── Sidebar props ────────────────────────────────────────────────────────────

interface SidebarProps {
  config: AdminConfig
  extraSections?: SidebarSection[] | undefined
  className?: string | undefined
  /** @deprecated No longer used */
  collapsed?: boolean | undefined
  /** @deprecated No longer used */
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar({ config, extraSections, className }: SidebarProps): React.ReactElement {
  const navigate = useNavigate()
  const location = useLocation()
  const path = location.pathname
  const [expanded, setExpanded] = useState(false)

  function isActive(item: NavItemDef): boolean {
    switch (item.id) {
      case "dashboard":
        return path === "/" || path === ""
      case "models":
        return path === "/models" || path.startsWith("/models/")
      case "database":
        return path.startsWith("/database")
      case "auth":
        return path.startsWith("/authentication")
      case "observability":
        return path.startsWith("/observability")
      case "ai":
        return path.startsWith("/ai")
      default:
        if (item.href === "/") return path === "/" || path === ""
        return path === item.href || path.startsWith(`${item.href}/`)
    }
  }

  const settingsActive =
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path.startsWith("/api")

  function NavItem({ icon, label, href, active }: {
    icon: string | undefined
    label: string
    href: string
    active: boolean
  }): React.ReactElement {
    return (
      <div className="px-1">
        <button
          type="button"
          title={!expanded ? label : undefined}
          onClick={() => { navigate(href); setExpanded(false) }}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex items-center w-full rounded-md transition-colors border-l-2",
            "hover:bg-accent hover:text-accent-foreground",
            expanded ? "gap-2.5 px-2 py-1.5" : "justify-center p-2",
            active
              ? "bg-accent text-foreground border-l-primary"
              : "text-muted-foreground border-l-transparent",
          )}
        >
          <span className={cn("shrink-0", active ? "opacity-100" : "opacity-60")}>
            <Icon name={icon} size={16} />
          </span>
          {expanded && (
            <>
              <span className="flex-1 text-left text-[13px] truncate">{label}</span>
              <span className="shrink-0 opacity-30"><IconChevronRight /></span>
            </>
          )}
        </button>
      </div>
    )
  }

  return (
    // Reserve 52px in the layout, panel floats over content when expanded
    <aside
      className={cn("relative shrink-0 w-[52px] h-full", className)}
      role="navigation"
      aria-label="Studio navigation"
    >
      {/* Floating panel: always 52px, expands to 220px on hover, overlays content */}
      <div
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        className={cn(
          "absolute top-0 left-0 h-full flex flex-col bg-background border-r border-border/80 z-50",
          "transition-[width] duration-200 ease-in-out overflow-hidden",
          expanded ? "w-[220px] shadow-xl shadow-black/10" : "w-[52px]",
        )}
      >
        <div className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: "none" }}>
          {PRIMARY_NAV_ENTRIES.map((entry) => (
            <NavItem
              key={entry.id}
              icon={entry.icon}
              label={entry.label}
              href={entry.href}
              active={isActive(entry)}
            />
          ))}
          {SECONDARY_NAV_ENTRIES.map((entry, i) => {
            if (entry === "separator") {
              return <div key={`sep-${i}`} className="my-1 mx-3 border-t border-border/50" />
            }
            return (
              <NavItem
                key={entry.id}
                icon={entry.icon}
                label={entry.label}
                href={entry.href}
                active={isActive(entry)}
              />
            )
          })}

          {extraSections && extraSections.length > 0 && (
            <>
              <div className="my-1 mx-3 border-t border-border/50" />
              {extraSections.map((section) => (
                <div key={section.title}>
                  {expanded && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                      {section.title}
                    </div>
                  )}
                  {section.items.map((item) => (
                    <NavItem
                      key={item.href}
                      icon={item.icon}
                      label={item.label}
                      href={item.href}
                      active={path === item.href || path.startsWith(`${item.href}/`)}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Pinned: Settings */}
        <div className="border-t border-border shrink-0">
          <div className="px-1 py-2">
            <button
              type="button"
              title={!expanded ? "Settings" : undefined}
              onClick={() => { navigate("/settings"); setExpanded(false) }}
              aria-current={settingsActive ? "page" : undefined}
              className={cn(
                "flex items-center w-full rounded-md transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                expanded ? "gap-2.5 px-2 py-1.5" : "justify-center p-2",
                settingsActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <span className={cn("shrink-0", settingsActive ? "opacity-100" : "opacity-60")}>
                <IconSettings size={16} />
              </span>
              {expanded && (
                <>
                  <span className="flex-1 text-left text-[13px] truncate">Settings</span>
                  <span className="shrink-0 opacity-30"><IconChevronRight /></span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ─── getPageTitle (used by TopBar) ────────────────────────────────────────────

export function getPageTitle(path: string, config: AdminConfig): string {
  if (path === "/" || path === "") return "Dashboard"

  const collMatch = path.match(/^\/models\/([^/]+)/)
  if (collMatch) {
    const model = config.models.find((m) => m.name === collMatch[1])
    if (model) {
      if (path.endsWith("/create")) return `Create ${model.label}`
      if (path.endsWith("/versions")) return "Version History"
      if (path.endsWith("/api")) return `${model.label}, REST API`
      if (path.endsWith("/graphql")) return `${model.label}, GraphQL`
      if (path.endsWith("/cache")) return `${model.label}, Cache`
      if (path.match(/\/models\/[^/]+\/[^/]+$/)) return `Edit ${model.label}`
      return model.labelPlural
    }
  }
  if (path === "/models") return "Models"

  const globalMatch = path.match(/^\/models\/globals\/([^/]+)/)
  if (globalMatch) {
    const g = config.globals.find((g) => g.name === globalMatch[1])
    if (g) {
      if (path.endsWith("/schema")) return `${g.label}, Schema`
      if (path.endsWith("/data")) return `${g.label}, Data`
      if (path.endsWith("/api")) return `${g.label}, REST API`
      if (path.endsWith("/graphql")) return `${g.label}, GraphQL`
      if (path.endsWith("/cache")) return `${g.label}, Cache`
      return g.label
    }
  }

  const titles: Record<string, string> = {
    "/database":             "Database",
    "/database/overview":    "Overview",
    "/database/sql":         "SQL Runner",
    "/database/migrations":  "Migrations",
    "/media-storage":        "Media & Storage",
    "/authentication":       "Authentication",
    "/email":                "Email",
    "/edge-functions":       "Edge Functions",
    "/realtime":             "Realtime",
    "/plugins":              "Plugins",
    "/observability":              "Observability",
    "/observability/logs":         "Logs",
    "/observability/logs/api":     "API Logs",
    "/observability/logs/auth":    "Auth Logs",
    "/observability/logs/storage": "Storage Logs",
    "/observability/logs/functions": "Edge Function Logs",
    "/observability/logs/realtime":  "Realtime Logs",
    "/observability/logs/postgres":  "Postgres Logs",
    "/observability/metrics":      "Metrics",
    "/observability/advisors":     "Advisors",
    "/api/rest":             "REST API",
    "/api/rest/settings":    "REST API Settings",
    "/api/rest/cache":       "REST API Cache",
    "/api/graphql":          "GraphQL",
    "/api/graphql/settings": "GraphQL Settings",
    "/settings":             "Settings",
  }
  return titles[path] ?? "Studio"
}

export function getPageBreadcrumbs(path: string, config: AdminConfig): string[] {
  if (path === "/" || path === "") return ["Dashboard"]

  const collMatch = path.match(/^\/models\/([^/]+)/)
  if (collMatch) {
    const model = config.models.find((m) => m.name === collMatch[1])
    if (model) {
      if (path.endsWith("/create")) return ["Models", model.labelPlural, `Create ${model.label}`]
      if (path.endsWith("/versions")) return ["Models", model.labelPlural, "Version History"]
      if (path.endsWith("/api")) return ["Models", model.labelPlural, "REST API"]
      if (path.endsWith("/graphql")) return ["Models", model.labelPlural, "GraphQL"]
      if (path.endsWith("/cache")) return ["Models", model.labelPlural, "Cache"]
      if (path.match(/\/models\/[^/]+\/[^/]+$/)) return ["Models", model.labelPlural, `Edit ${model.label}`]
      return ["Models", model.labelPlural]
    }
  }
  if (path === "/models") return ["Models"]

  const globalMatch = path.match(/^\/models\/globals\/([^/]+)/)
  if (globalMatch) {
    const g = config.globals.find((g) => g.name === globalMatch[1])
    if (g) {
      if (path.endsWith("/schema")) return ["Models", g.label, "Schema"]
      if (path.endsWith("/data")) return ["Models", g.label, "Data"]
      if (path.endsWith("/api")) return ["Models", g.label, "REST API"]
      if (path.endsWith("/graphql")) return ["Models", g.label, "GraphQL"]
      if (path.endsWith("/cache")) return ["Models", g.label, "Cache"]
      return ["Models", g.label]
    }
  }

  const breadcrumbs: Record<string, string[]> = {
    "/database":             ["Database"],
    "/database/overview":    ["Database", "Overview"],
    "/database/sql":         ["Database", "SQL Runner"],
    "/database/migrations":  ["Database", "Migrations"],
    "/media-storage":        ["Media & Storage"],
    "/authentication":       ["Authentication"],
    "/email":                ["Email"],
    "/edge-functions":       ["Edge Functions"],
    "/realtime":             ["Realtime"],
    "/plugins":              ["Plugins"],
    "/observability":                  ["Observability"],
    "/observability/logs":             ["Observability", "Logs"],
    "/observability/logs/api":         ["Observability", "Logs", "API"],
    "/observability/logs/auth":        ["Observability", "Logs", "Auth"],
    "/observability/logs/storage":     ["Observability", "Logs", "Storage"],
    "/observability/logs/functions":   ["Observability", "Logs", "Edge Functions"],
    "/observability/logs/realtime":    ["Observability", "Logs", "Realtime"],
    "/observability/logs/postgres":    ["Observability", "Logs", "Postgres"],
    "/observability/metrics":          ["Observability", "Metrics"],
    "/observability/advisors":         ["Observability", "Advisors"],
    "/api/rest":             ["API", "REST"],
    "/api/rest/settings":    ["API", "REST", "Settings"],
    "/api/rest/cache":       ["API", "REST", "Cache"],
    "/api/graphql":          ["API", "GraphQL"],
    "/api/graphql/settings": ["API", "GraphQL", "Settings"],
    "/settings":             ["Settings"],
  }
  return breadcrumbs[path] ?? ["Studio"]
}
