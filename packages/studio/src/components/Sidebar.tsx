import React, { useState } from "react"
import type { AdminConfig } from "../config.js"
import { cn } from "../lib/utils.js"

export type StudioMode = "content" | "developer"

interface SidebarProps {
  currentPath: string
  onNavigate: (path: string) => void
  config: AdminConfig
  mode: StudioMode
  onModeChange: (mode: StudioMode) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  className?: string
}

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function IconHome({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
}
function IconFileText({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
}
function IconImage({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
}
function IconDatabase({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
}
function IconShield({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
}
function IconHardDrive({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>
}
function IconBook({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
}
function IconSettings({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
function IconTable({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
}
function IconTerminal({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
}
function IconGit({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
}
function IconActivity({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
}
function IconUsers({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
}
function IconTag({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
}
function IconGlobe({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
}
function IconChevronLeft({ size = 20 }: { size?: number }): React.ReactElement {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
}

const iconMap: Record<string, (props: { size?: number }) => React.ReactElement> = {
  home: IconHome,
  "file-text": IconFileText,
  image: IconImage,
  database: IconDatabase,
  shield: IconShield,
  "hard-drive": IconHardDrive,
  book: IconBook,
  settings: IconSettings,
  table: IconTable,
  terminal: IconTerminal,
  git: IconGit,
  activity: IconActivity,
  users: IconUsers,
  tag: IconTag,
  globe: IconGlobe,
  "chevron-left": IconChevronLeft,
}

export function Icon({ name, size = 16 }: { name: string | undefined; size?: number }): React.ReactElement | null {
  if (!name) return null
  const Comp = iconMap[name]
  if (!Comp) return null
  return <Comp size={size} />
}

// ─── Nav data ────────────────────────────────────────────────────────────────

interface NavItem {
  href: string
  label: string
  icon?: string
}

interface NavGroup {
  title: string
  items: NavItem[]
}

function getNavGroups(mode: StudioMode, config: AdminConfig): NavGroup[] {
  if (mode === "content") {
    const groups: NavGroup[] = [
      {
        title: "General",
        items: [
          { href: "/", label: "Dashboard", icon: "home" },
          { href: "/media", label: "Media Library", icon: "image" },
        ],
      },
    ]

    const modelItems = config.models.map((m) => ({
      href: `/collections/${m.name}`,
      label: m.labelPlural,
      icon: m.name === "post" ? "file-text" : m.name === "author" ? "users" : m.name === "tag" ? "tag" : "file-text",
    }))
    if (modelItems.length > 0) {
      groups.push({ title: "Collections", items: modelItems })
    }

    const globalItems = config.globals.map((g) => ({
      href: `/globals/${g.name}`,
      label: g.label,
      icon: "globe",
    }))
    if (globalItems.length > 0) {
      groups.push({ title: "Globals", items: globalItems })
    }

    return groups
  }

  // Developer mode
  return [
    {
      title: "Database",
      items: [
        { href: "/dev/schema", label: "Schema", icon: "database" },
        { href: "/dev/data", label: "Data Explorer", icon: "table" },
        { href: "/dev/sql", label: "SQL Runner", icon: "terminal" },
        { href: "/dev/migrations", label: "Migrations", icon: "git" },
      ],
    },
    {
      title: "Services",
      items: [
        { href: "/dev/auth", label: "Authentication", icon: "shield" },
        { href: "/dev/storage", label: "Storage", icon: "hard-drive" },
      ],
    },
    {
      title: "API",
      items: [
        { href: "/dev/api", label: "API Docs", icon: "book" },
        { href: "/dev/logs", label: "Logs", icon: "activity" },
      ],
    },
    {
      title: "Configuration",
      items: [
        { href: "/dev/settings", label: "Settings", icon: "settings" },
      ],
    },
  ]
}

/** Get page title from path */
export function getPageTitle(path: string, config: AdminConfig): string {
  if (path === "/" || path === "") return "Dashboard"
  if (path === "/media") return "Media Library"

  const collMatch = path.match(/^\/collections\/([^/]+)/)
  if (collMatch) {
    const model = config.models.find((m) => m.name === collMatch[1])
    if (model) {
      if (path.endsWith("/create")) return `Create ${model.label}`
      if (path.endsWith("/versions")) return "Version History"
      if (path.match(/\/collections\/[^/]+\/[^/]+$/)) return `Edit ${model.label}`
      return model.labelPlural
    }
  }

  const globalMatch = path.match(/^\/globals\/([^/]+)/)
  if (globalMatch) {
    const global = config.globals.find((g) => g.name === globalMatch[1])
    if (global) return global.label
  }

  if (path === "/dev/schema") return "Schema"
  if (path === "/dev/data") return "Data Explorer"
  if (path === "/dev/sql") return "SQL Runner"
  if (path === "/dev/migrations") return "Migrations"
  if (path === "/dev/auth") return "Authentication"
  if (path === "/dev/storage") return "Storage"
  if (path === "/dev/api") return "API Docs"
  if (path === "/dev/logs") return "Logs"
  if (path === "/dev/settings") return "Settings"
  return "Studio"
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

export function Sidebar({ currentPath, onNavigate, config, mode, onModeChange, collapsed, onCollapsedChange, className }: SidebarProps): React.ReactElement {
  const navGroups = getNavGroups(mode, config)

  return (
    <aside
      className={cn(
        "flex flex-col bg-card border-r border-border shrink-0 h-full transition-[width] duration-200 overflow-hidden",
        collapsed ? "w-[60px]" : "w-[260px]",
        className,
      )}
      role="navigation"
      aria-label="Studio navigation"
    >
      {/* Header: Logo + project name */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-border shrink-0">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-primary-foreground shrink-0">
          <span className="text-sm font-bold">S</span>
        </div>
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">
              {config.branding?.appName ?? "Supatype"}
            </span>
            <span className="text-[11px] text-muted-foreground">Studio</span>
          </div>
        )}
      </div>

      {/* Mode toggle */}
      <div className={cn("px-3 pt-3 pb-1 shrink-0", collapsed && "px-1.5")}>
        {collapsed ? (
          <div className="flex flex-col gap-1 items-center">
            <button
              type="button"
              title="Content"
              onClick={() => { onModeChange("content"); onNavigate("/") }}
              className={cn(
                "flex items-center justify-center w-9 h-8 rounded-md text-xs transition-colors",
                mode === "content"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon name="file-text" size={14} />
            </button>
            <button
              type="button"
              title="Developer"
              onClick={() => { onModeChange("developer"); onNavigate("/dev/schema") }}
              className={cn(
                "flex items-center justify-center w-9 h-8 rounded-md text-xs transition-colors",
                mode === "developer"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon name="terminal" size={14} />
            </button>
          </div>
        ) : (
          <div className="flex p-0.5 rounded-lg bg-muted">
            <button
              type="button"
              onClick={() => { onModeChange("content"); onNavigate("/") }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                mode === "content"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name="file-text" size={12} />
              Content
            </button>
            <button
              type="button"
              onClick={() => { onModeChange("developer"); onNavigate("/dev/schema") }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                mode === "developer"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name="terminal" size={12} />
              Developer
            </button>
          </div>
        )}
      </div>

      {/* Nav groups */}
      <div className="flex-1 overflow-y-auto py-2 px-3" style={{ scrollbarWidth: "none" }}>
        {navGroups.map((group) => (
          <div key={group.title} className="mb-4">
            {!collapsed && (
              <h3 className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = item.href === "/"
                  ? currentPath === "/" || currentPath === ""
                  : currentPath === item.href || currentPath.startsWith(`${item.href}/`)
                return (
                  <li key={item.href}>
                    <button
                      type="button"
                      title={collapsed ? item.label : undefined}
                      onClick={() => onNavigate(item.href)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 w-full rounded-md text-[13px] transition-colors",
                        collapsed ? "justify-center px-0 py-2" : "px-2 py-1.5",
                        "hover:bg-accent hover:text-accent-foreground",
                        active
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className={cn("shrink-0", active ? "opacity-100" : "opacity-60")}>
                        <Icon name={item.icon} size={16} />
                      </span>
                      {!collapsed && item.label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* Footer: collapse toggle + user */}
      <div className="border-t border-border px-3 py-2 shrink-0">
        {/* Collapse toggle */}
        <button
          type="button"
          onClick={() => onCollapsedChange(!collapsed)}
          className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <span className={cn("shrink-0 transition-transform", collapsed && "rotate-180")}>
            <Icon name="chevron-left" size={16} />
          </span>
          {!collapsed && "Collapse"}
        </button>

        {/* User */}
        <div className={cn("flex items-center gap-2.5 mt-1 px-2 py-1.5 rounded-md", collapsed && "justify-center px-0")}>
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/20 text-primary text-xs font-semibold shrink-0">
            U
          </div>
          {!collapsed && (
            <div className="flex flex-col min-w-0">
              <span className="text-[13px] font-medium text-foreground truncate">User</span>
              <span className="text-[11px] text-muted-foreground truncate">admin@example.com</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
