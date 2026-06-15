"use client"

import React, { useState } from "react"
import { useLocation } from "react-router-dom"
import type { AdminConfig } from "../config.js"
import { LocaleSwitcher } from "./LocaleSwitcher.js"
import { SupatypeIcon } from "./SupatypeLogo.js"
import { Badge } from "./ui/badge.js"
import { ConnectModal } from "./ConnectModal.js"
import { JumpToSearch } from "./JumpToSearch.js"
import { UserAccountMenu } from "./UserAccountMenu.js"

const FEEDBACK_URL = "https://github.com/supatype/supatype/issues/new/choose"
const DOCS_URL = "https://supatype.com/docs"

interface TopBarProps {
  config: AdminConfig | null
  /** Components rendered after the logo "/" separator (left slot — project switcher, branch indicator). */
  leftItems?: React.ComponentType[] | undefined
  /** Components rendered on the right side before the avatar. */
  extraItems?: React.ComponentType[] | undefined
  /** Sample-data mode (self-host) — shows a badge. */
  demoMode?: boolean | undefined
  onToggleSidebar: () => void
}

function BranchPill(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-0.5 text-xs text-muted-foreground">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-primary shrink-0" aria-hidden>
        <path d="M6 3v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
        <path d="M6 9a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="18" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      </svg>
      Main
    </span>
  )
}

function HelpIcon(): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

function HamburgerIcon(): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  )
}

function PlugIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" />
      <path d="M18 8H6a2 2 0 0 0-2 2v3a6 6 0 0 0 12 0v-3a2 2 0 0 0-2-2z" />
    </svg>
  )
}

export function TopBar({ config, leftItems, extraItems, demoMode, onToggleSidebar }: TopBarProps): React.ReactElement {
  const location = useLocation()
  const [connectOpen, setConnectOpen] = useState(false)

  // Determine locale-switcher visibility: show when on content/collection routes
  const showLocaleSwitcher = config != null && (
    location.pathname === "/" ||
    location.pathname.startsWith("/models") ||
    location.pathname.startsWith("/collections") ||
    location.pathname.startsWith("/models/globals") ||
    location.pathname === "/media"
  )

  const hasLeftItems = leftItems && leftItems.length > 0

  return (
    <header className="flex items-center h-14 px-4 bg-background border-b border-border shrink-0 gap-3 z-50">
      {/* Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <SupatypeIcon size={22} />

        {/* Mobile sidebar toggle */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors md:hidden"
          aria-label="Toggle sidebar"
        >
          <HamburgerIcon />
        </button>
      </div>

      {/* Left slot: "/" + extension components (project name, branch indicator) */}
      {hasLeftItems && (
        <>
          <span className="text-muted-foreground/50 text-lg select-none shrink-0">/</span>
          <div className="flex items-center gap-2 min-w-0">
            {leftItems!.map((Item, i) => (
              <Item key={i} />
            ))}
          </div>
        </>
      )}

      {!hasLeftItems && (
        <>
          <span className="text-muted-foreground/50 text-lg select-none shrink-0">/</span>
          <span className="text-sm text-muted-foreground truncate max-w-[200px]">Studio</span>
          <BranchPill />
        </>
      )}

      {demoMode && (
        <Badge variant="secondary" className="shrink-0 text-[11px] border-primary/40 text-primary">
          Demo
        </Badge>
      )}

      {/* Centre: jump-to search (hidden on dashboard where it lives inline) */}
      <div className="flex-1 flex items-center justify-center px-4">
        {location.pathname !== "/" && (
          <div className="w-full max-w-md">
            <JumpToSearch compact />
          </div>
        )}
      </div>

      {/* Right: extra items from extension */}
      {extraItems?.map((Item, i) => (
        <Item key={i} />
      ))}

      {/* Locale switcher (content routes only) */}
      {showLocaleSwitcher && <LocaleSwitcher />}

      {/* Connect button */}
      <button
        type="button"
        onClick={() => setConnectOpen(true)}
        className="hidden sm:flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 hover:bg-accent transition-colors shrink-0 font-medium"
      >
        <PlugIcon />
        Connect
      </button>

      {/* Feedback link */}
      <a
        href={FEEDBACK_URL}
        target="_blank"
        rel="noreferrer"
        className="hidden sm:block text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
      >
        Feedback
      </a>

      {/* Help — docs */}
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center w-7 h-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors shrink-0"
        aria-label="Documentation"
      >
        <HelpIcon />
      </a>

      <UserAccountMenu demoMode={demoMode} />

      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </header>
  )
}
