import React, { useState, useEffect } from "react"
import { Button } from "@supatype/ui"
import { clsx } from "clsx"

interface PlatformUser {
  name: string
  email: string
  avatar?: string
}

function getPlatformUser(): PlatformUser | null {
  if (typeof document === "undefined") return null
  const cookie = document.cookie
    .split("; ")
    .find((c) => c.startsWith("st-platform-user="))
  if (!cookie) return null
  try {
    return JSON.parse(decodeURIComponent(cookie.split("=")[1]!)) as PlatformUser
  } catch {
    return null
  }
}

const NAV_LINKS = [
  { label: "Product", href: "/", items: [
    { label: "Database", href: "/database" },
    { label: "Auth", href: "/auth" },
    { label: "Storage", href: "/storage" },
    { label: "Admin Panel", href: "/admin-panel" },
    { label: "Realtime", href: "/realtime" },
  ]},
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
]

export const Header: React.FC<{ currentPath?: string }> = ({ currentPath }) => {
  const [user, setUser] = useState<PlatformUser | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    setUser(getPlatformUser())
  }, [])

  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/80 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2 text-lg font-bold text-neutral-900 dark:text-white">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-purple-600">
            <rect width="24" height="24" rx="6" fill="currentColor" />
            <path d="M7 8h10M7 12h7M7 16h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Supatype
        </a>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={clsx(
                "text-sm font-medium transition-colors hover:text-purple-600",
                currentPath === link.href
                  ? "text-purple-600"
                  : "text-neutral-600 dark:text-neutral-400",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Auth CTAs */}
        <div className="hidden items-center gap-3 md:flex">
          {user ? (
            <a href="/dashboard">
              <Button variant="primary" size="sm">Dashboard</Button>
            </a>
          ) : (
            <>
              <a href="/dashboard/sign-in">
                <Button variant="ghost" size="sm">Sign in</Button>
              </a>
              <a href="/dashboard/sign-up">
                <Button variant="primary" size="sm">Start your project</Button>
              </a>
            </>
          )}
        </div>

        {/* Mobile menu button */}
        <button
          className="md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-600 dark:text-neutral-400">
            {mobileOpen
              ? <path d="M6 6l12 12M6 18L18 6" />
              : <path d="M4 6h16M4 12h16M4 18h16" />
            }
          </svg>
        </button>
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <div className="border-t border-neutral-200 bg-white px-4 py-4 dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
          <nav className="flex flex-col gap-3">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-neutral-600 hover:text-purple-600 dark:text-neutral-400"
              >
                {link.label}
              </a>
            ))}
            <hr className="border-neutral-200 dark:border-neutral-800" />
            {user ? (
              <a href="/dashboard">
                <Button variant="primary" size="sm" className="w-full">Dashboard</Button>
              </a>
            ) : (
              <>
                <a href="/dashboard/sign-in">
                  <Button variant="ghost" size="sm" className="w-full">Sign in</Button>
                </a>
                <a href="/dashboard/sign-up">
                  <Button variant="primary" size="sm" className="w-full">Start your project</Button>
                </a>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  )
}
