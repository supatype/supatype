import React, { useState, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import type { AdminConfig } from "../config.js"
import type { StudioMode } from "./Sidebar.js"
import { getPageTitle, Icon } from "./Sidebar.js"
import { LocaleSwitcher } from "./LocaleSwitcher.js"
import { useCloud } from "../hooks/useCloud.js"

interface TopBarProps {
  config: AdminConfig | null
  mode: StudioMode
  onToggleSidebar: () => void
}

export function TopBar({ config, mode, onToggleSidebar }: TopBarProps): React.ReactElement {
  const location = useLocation()
  const pageTitle = config ? getPageTitle(location.pathname, config) : "Supatype Studio"
  const [scrolled, setScrolled] = useState(false)
  const cloud = useCloud()

  useEffect(() => {
    const main = document.getElementById("studio-main")
    if (!main) return
    const handler = () => setScrolled(main.scrollTop > 10)
    main.addEventListener("scroll", handler, { passive: true })
    return () => main.removeEventListener("scroll", handler)
  }, [])

  return (
    <header
      className={`sticky top-0 z-50 flex items-center h-14 px-4 bg-background/80 backdrop-blur-lg border-b shrink-0 gap-4 transition-shadow ${scrolled ? "shadow-sm border-border" : "border-transparent"}`}
    >
      {/* Mobile: logo + sidebar trigger */}
      <div className="flex items-center gap-2 md:hidden">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground shrink-0">
          <span className="text-xs font-bold">S</span>
        </div>
        <button
          type="button"
          onClick={onToggleSidebar}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Toggle sidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>

      {/* Cloud: Project switcher */}
      {cloud.mode === "cloud" && cloud.features.projectSwitcher && cloud.activeProject && (
        <ProjectSwitcher />
      )}

      {/* Page title */}
      <h1 className="text-lg font-semibold text-foreground truncate">{pageTitle}</h1>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Cloud: Environment switcher */}
      {cloud.mode === "cloud" && cloud.features.environments && cloud.activeProject && (
        <CloudEnvironmentSwitcher />
      )}

      {/* Locale switcher (content mode only) */}
      {mode === "content" && <LocaleSwitcher />}

      {/* User avatar */}
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/20 text-primary text-xs font-semibold shrink-0">
        U
      </div>
    </header>
  )
}

// ─── Project Switcher ─────────────────────────────────────────────────────────

function ProjectSwitcher(): React.ReactElement {
  const navigate = useNavigate()
  const { projects, activeProject, setActiveProject } = useCloud()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1 rounded-md text-sm hover:bg-accent transition-colors"
      >
        <div className={`w-2 h-2 rounded-full ${activeProject?.status === "active" ? "bg-emerald-400" : "bg-amber-400"}`} />
        <span className="font-medium text-foreground max-w-[140px] truncate">{activeProject?.name}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden">
            <div className="p-2 border-b border-border">
              <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider px-2 py-1">
                Projects
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setActiveProject(p); setOpen(false) }}
                  className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm transition-colors ${
                    p.id === activeProject?.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full shrink-0 ${
                    p.status === "active" ? "bg-emerald-400" : p.status === "paused" ? "bg-amber-400" : "bg-blue-400"
                  }`} />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground capitalize">{p.tier}</span>
                </button>
              ))}
            </div>
            <div className="p-1 border-t border-border">
              <button
                type="button"
                onClick={() => { setActiveProject(null); setOpen(false); navigate("/cloud/projects") }}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <Icon name="chevron-left" size={14} />
                Back to all projects
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Environment Switcher ─────────────────────────────────────────────────────

function CloudEnvironmentSwitcher(): React.ReactElement {
  const { activeEnvironment, setActiveEnvironment } = useCloud()
  const envs = ["production", "staging", "preview"] as const

  return (
    <div className="flex p-0.5 rounded-lg bg-muted">
      {envs.map((env) => (
        <button
          key={env}
          type="button"
          onClick={() => setActiveEnvironment(env)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors capitalize ${
            activeEnvironment === env
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {env}
        </button>
      ))}
    </div>
  )
}
