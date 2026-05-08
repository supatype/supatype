"use client"

import type { User } from "@supatype/client"
import React, { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { useCloudUrl } from "../hooks/useCloudUrl.js"
import { useStudioAuth } from "../hooks/useStudioAuth.js"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js"

interface PlatformCookieUser {
  name: string
  email: string
  avatar?: string
}

function getPlatformCookieUser(): PlatformCookieUser | null {
  if (typeof document === "undefined") return null
  const cookie = document.cookie.split("; ").find((c) => c.startsWith("st-platform-user="))
  if (!cookie) return null
  try {
    return JSON.parse(decodeURIComponent(cookie.split("=")[1]!)) as PlatformCookieUser
  } catch {
    return null
  }
}

function stringFromUnknown(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function avatarFromUser(user: User): string | undefined {
  const m = user.userMetadata ?? {}
  return (
    stringFromUnknown(m.avatar_url) ??
    stringFromUnknown(m.avatar) ??
    stringFromUnknown(m.picture)
  )
}

function displayLabelFromUser(user: User): string {
  const m = user.userMetadata ?? {}
  return (
    stringFromUnknown(m.full_name) ??
    stringFromUnknown(m.name) ??
    user.email ??
    user.phone ??
    "Account"
  )
}

function initialsFrom(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean)
  if (p.length >= 2) return (p[0]![0]! + p[1]![0]!).toUpperCase()
  return (name.trim()[0] ?? "U").toUpperCase()
}

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/$/, "")
}

export interface UserAccountMenuProps {
  demoMode?: boolean | undefined
}

export function UserAccountMenu({ demoMode }: UserAccountMenuProps): React.ReactElement {
  const { user, loading, signOut } = useStudioAuth()
  const cloudUrl = useCloudUrl()
  const [cookieUser, setCookieUser] = useState<PlatformCookieUser | null>(null)

  useEffect(() => {
    setCookieUser(getPlatformCookieUser())
  }, [user?.id])

  const displayName = user
    ? displayLabelFromUser(user)
    : (cookieUser?.name ||
        cookieUser?.email ||
        (demoMode ? "Demo mode" : "Local studio"))

  const subtitle = user?.email ?? cookieUser?.email ?? (demoMode ? "Sample dataset" : null)

  const avatarUrl =
    user !== null ? avatarFromUser(user) : cookieUser?.avatar

  const accountDashboardHref =
    cloudUrl !== undefined ? `${normalizeBaseUrl(cloudUrl)}/dashboard` : null

  const initials =
    avatarUrl !== undefined && avatarUrl.length > 0
      ? null
      : initialsFrom(displayName)

  const triggerAvatar = avatarUrl !== undefined && avatarUrl.length > 0
    ? (
        <span className="flex h-8 w-8 shrink-0 overflow-hidden rounded-full border border-border ring-offset-background ring-primary/40 focus-within:ring-2">
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        </span>
      )
    : (
        <span className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary ring-offset-background transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {loading ? "…" : initials ?? "?"}
        </span>
      )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Account menu"
      >
        {triggerAvatar}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
        <DropdownMenuLabel className="font-normal leading-tight">
          <div className="truncate font-semibold">{displayName}</div>
          {subtitle !== null && subtitle.length > 0 && (
            <div className="truncate text-xs font-normal text-muted-foreground">{subtitle}</div>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">Project settings</Link>
        </DropdownMenuItem>
        {accountDashboardHref !== null && (
          <DropdownMenuItem asChild>
            <a href={accountDashboardHref} target="_blank" rel="noreferrer">
              Manage account…
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            void signOut()
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
