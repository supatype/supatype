"use client"

import React, { useState } from "react"
import { useLocation } from "react-router-dom"
import type { AdminConfig } from "../config.js"
import { LocaleSwitcher } from "./LocaleSwitcher.js"
import { SupatypeIcon } from "./SupatypeLogo.js"
import { Badge, Button, IconLink, TextLink } from "./ui.js"
import { ConnectModal } from "./ConnectModal.js"
import { JumpToSearch, JumpToSearchSheet } from "./JumpToSearch.js"
import { UserAccountMenu } from "./UserAccountMenu.js"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js"
import { cn } from "../lib/utils.js"

const FEEDBACK_URL = "https://github.com/supatype/supatype/issues/new/choose"
const DOCS_URL = "https://supatype.com/docs"

interface TopBarProps {
  config: AdminConfig | null
  /** Components rendered after the logo "/" separator (left slot, project switcher, branch indicator). */
  leftItems?: React.ComponentType[] | undefined
  /** Components rendered on the right side before the avatar. */
  extraItems?: React.ComponentType[] | undefined
  /** Sample-data mode (self-host): shows a badge. */
  demoMode?: boolean | undefined
  /** The phone-width primary menu the burger opens and closes. */
  sidebar: SidebarToggle
}

/** What the burger needs to drive the primary menu and say so to assistive technology. */
export interface SidebarToggle {
  open: boolean
  onToggle: () => void
  /** The id of the menu the burger opens, for `aria-controls`. */
  controls: string
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

function PlugIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" />
      <path d="M18 8H6a2 2 0 0 0-2 2v3a6 6 0 0 0 12 0v-3a2 2 0 0 0-2-2z" />
    </svg>
  )
}

function MoreIcon(): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
    </svg>
  )
}

function Slash({ className }: { className?: string }): React.ReactElement {
  return (
    <svg width="8" height="22" viewBox="0 0 8 22" className={cn("shrink-0 text-muted-foreground/50", className)} aria-hidden>
      <path d="M6.5 1.5 1.5 20.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

/** The locale switcher shows on content routes, where records have per-locale values. */
function isContentRoute(path: string): boolean {
  return path === "/" || path.startsWith("/models") || path.startsWith("/collections") || path === "/media"
}

/**
 * After the logo: an extension's own items (project name, branch), or Studio's name and branch.
 * Studio's are dropped below `sm`, where the header has no room for a label nobody acts on.
 */
function HeaderContext({ leftItems }: { leftItems: React.ComponentType[] | undefined }): React.ReactElement {
  if (leftItems && leftItems.length > 0) {
    return (
      <>
        <Slash />
        <div className="flex min-w-0 items-center gap-2">
          {leftItems.map((Item, i) => <Item key={i} />)}
        </div>
      </>
    )
  }
  return (
    <>
      <Slash className="hidden sm:block" />
      <span className="hidden sm:inline max-w-[200px] truncate text-sm text-muted-foreground">Studio</span>
      <span className="hidden sm:inline-flex"><BranchPill /></span>
    </>
  )
}

/**
 * Connect, Feedback and the docs. From `sm` up each sits in the header; below it they share one
 * overflow menu, so the header fits a 360px phone without cropping the account menu off its end.
 */
function HeaderLinks({ onConnect }: { onConnect: () => void }): React.ReactElement {
  return (
    <>
      <Button type="button" onClick={onConnect} className="hidden sm:inline-flex h-7 px-2.5 shrink-0">
        <PlugIcon />
        Connect
      </Button>
      <TextLink tone="muted" href={FEEDBACK_URL} target="_blank" rel="noreferrer" className="hidden sm:inline-flex text-sm shrink-0">
        Feedback
      </TextLink>
      <IconLink label="Documentation" href={DOCS_URL} target="_blank" rel="noreferrer" className="hidden sm:inline-flex rounded-full border border-border hover:bg-transparent hover:border-foreground/30">
        <HelpIcon />
      </IconLink>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More" className="sm:hidden"><MoreIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onConnect}>Connect</DropdownMenuItem>
          <DropdownMenuItem asChild><a href={FEEDBACK_URL} target="_blank" rel="noreferrer">Feedback</a></DropdownMenuItem>
          <DropdownMenuItem asChild><a href={DOCS_URL} target="_blank" rel="noreferrer">Documentation</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/**
 * The burger that opens the phone-width primary menu. It says whether that menu is open and
 * names it, so a screen reader hears the state change that a sighted user sees.
 */
function SidebarBurger({ sidebar }: { sidebar: SidebarToggle }): React.ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={sidebar.onToggle}
      className="md:hidden"
      aria-label="Toggle sidebar"
      aria-expanded={sidebar.open}
      aria-controls={sidebar.controls}
    >
      <HamburgerIcon />
    </Button>
  )
}

/**
 * The centre jump-to search, hidden on the dashboard where it lives inline. Below `md` it is a
 * button opening a full-width sheet: inline, it was squeezed too narrow to read.
 */
function HeaderSearch({ onDashboard }: { onDashboard: boolean }): React.ReactElement {
  return (
    <>
      <div className="flex-1 flex items-center justify-center md:px-4">
        {!onDashboard && (
          <div className="hidden md:block w-full max-w-md">
            <JumpToSearch compact />
          </div>
        )}
      </div>
      {!onDashboard && <JumpToSearchSheet className="md:hidden" />}
    </>
  )
}

export function TopBar({ config, leftItems, extraItems, demoMode, sidebar }: TopBarProps): React.ReactElement {
  const { pathname } = useLocation()
  const [connectOpen, setConnectOpen] = useState(false)

  return (
    <header className="z-50 flex h-14 shrink-0 items-center gap-2 sm:gap-3 border-b border-border bg-background px-3 sm:px-4">
      <div className="flex shrink-0 items-center gap-2">
        <SupatypeIcon size={22} className="h-[22px] w-[25px]" />
        <SidebarBurger sidebar={sidebar} />
      </div>
      <HeaderContext leftItems={leftItems} />
      {demoMode && (
        <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">
          Demo
        </Badge>
      )}
      <HeaderSearch onDashboard={pathname === "/"} />
      {extraItems?.map((Item, i) => <Item key={i} />)}
      {config != null && isContentRoute(pathname) && <LocaleSwitcher />}
      <HeaderLinks onConnect={() => setConnectOpen(true)} />
      <UserAccountMenu demoMode={demoMode} />
      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </header>
  )
}
