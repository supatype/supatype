"use client"

import React, { useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import type { AdminConfig } from "../config.js"
import type { SidebarSection } from "../types.js"
import { cn } from "../lib/utils.js"

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function IconHome({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
}
function IconGrid({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
}
function IconDatabase({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
}
function IconImage({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
}
function IconUsers({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
}
function IconMail({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
}
function IconZap({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
}
function IconRadio({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 6l11 6L1 18V6z"/><path d="M23 6l-11 6 11 6V6z"/></svg>
}
function IconPlug({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18"/><path d="M7 17l-4 4"/><path d="M17 7l4-4"/><path d="M10 3l1 1-7 7-1-1a4 4 0 0 1 7-7z"/><path d="M14 21l-1-1 7-7 1 1a4 4 0 0 1-7 7z"/></svg>
}
function IconLightbulb({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>
}
function IconEye({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
}
function IconList({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
}
function IconBook({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
}
function IconGlobe({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
}
function IconClock({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
}
function IconCpu({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
}
function IconShoppingCart({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
}
function IconBarChart2({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
}
function IconGitBranch({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
}
function IconLink({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
}
function IconBot({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 11V8"/><circle cx="12" cy="6" r="2"/><line x1="3" y1="16" x2="1" y2="16"/><line x1="23" y1="16" x2="21" y2="16"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/></svg>
}
function IconSettings({ size = 16 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
function IconChevronRight({ size = 13 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
}

// ─── Icon lookup ──────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, (props: { size?: number }) => React.ReactElement> = {
  home: IconHome,
  grid: IconGrid,
  database: IconDatabase,
  image: IconImage,
  users: IconUsers,
  mail: IconMail,
  zap: IconZap,
  radio: IconRadio,
  plug: IconPlug,
  lightbulb: IconLightbulb,
  eye: IconEye,
  list: IconList,
  book: IconBook,
  settings: IconSettings,
  globe: IconGlobe,
  clock: IconClock,
  cpu: IconCpu,
  cart: IconShoppingCart,
  barchart: IconBarChart2,
  branch: IconGitBranch,
  link: IconLink,
  bot: IconBot,
}

export function Icon({ name, size = 16 }: { name: string | undefined; size?: number }): React.ReactElement | null {
  if (!name) return null
  const Comp = ICON_MAP[name]
  if (!Comp) return null
  return <Comp size={size} />
}

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
    // Reserve 52px in the layout — panel floats over content when expanded
    <aside
      className={cn("relative shrink-0 w-[52px] h-full", className)}
      role="navigation"
      aria-label="Studio navigation"
    >
      {/* Floating panel — always 52px, expands to 220px on hover, overlays content */}
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
      if (path.endsWith("/api")) return `${model.label} — REST API`
      if (path.endsWith("/graphql")) return `${model.label} — GraphQL`
      if (path.match(/\/models\/[^/]+\/[^/]+$/)) return `Edit ${model.label}`
      return model.labelPlural
    }
  }
  if (path === "/models") return "Models"

  const globalMatch = path.match(/^\/models\/globals\/([^/]+)/)
  if (globalMatch) {
    const g = config.globals.find((g) => g.name === globalMatch[1])
    if (g) {
      if (path.endsWith("/schema")) return `${g.label} — Schema`
      if (path.endsWith("/data")) return `${g.label} — Data`
      if (path.endsWith("/api")) return `${g.label} — REST API`
      if (path.endsWith("/graphql")) return `${g.label} — GraphQL`
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
    "/api/graphql":          ["API", "GraphQL"],
    "/api/graphql/settings": ["API", "GraphQL", "Settings"],
    "/settings":             ["Settings"],
  }
  return breadcrumbs[path] ?? ["Studio"]
}
