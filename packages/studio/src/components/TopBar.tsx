import React, { useState, useEffect } from "react"
import type { AdminConfig } from "../config.js"
import type { StudioMode } from "./Sidebar.js"
import { getPageTitle, Icon } from "./Sidebar.js"
import { LocaleSwitcher } from "./LocaleSwitcher.js"

interface TopBarProps {
  currentPath: string
  config: AdminConfig
  mode: StudioMode
  onToggleSidebar: () => void
}

export function TopBar({ currentPath, config, mode, onToggleSidebar }: TopBarProps): React.ReactElement {
  const pageTitle = getPageTitle(currentPath, config)
  const [scrolled, setScrolled] = useState(false)

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

      {/* Page title */}
      <h1 className="text-lg font-semibold text-foreground truncate">{pageTitle}</h1>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Locale switcher (content mode only) */}
      {mode === "content" && <LocaleSwitcher />}

      {/* User avatar */}
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/20 text-primary text-xs font-semibold shrink-0">
        U
      </div>
    </header>
  )
}
