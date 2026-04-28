import React, { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import type { ModelConfig } from "../config.js"
import type { SupatypeClient } from "@supatype/client"

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchItem = {
  label: string
  description?: string
  href: string
  category: string
  kind: "route" | "record"
}

// ─── Static route index ───────────────────────────────────────────────────────

function buildRouteItems(models: ModelConfig[]): SearchItem[] {
  const items: SearchItem[] = [
    { label: "Dashboard",              href: "/",                                  category: "Core",          kind: "route" },
    { label: "Models",                 href: "/models",                            category: "Core",          kind: "route" },
    { label: "Database Overview",      href: "/database/overview",                 category: "Database",      kind: "route" },
    { label: "SQL Runner",             href: "/database/sql",                      category: "Database",      kind: "route" },
    { label: "Migrations",             href: "/database/migrations",               category: "Database",      kind: "route" },
    { label: "Tables",                 href: "/database/tables",                   category: "Database",      kind: "route" },
    { label: "Views",                  href: "/database/views",                    category: "Database",      kind: "route" },
    { label: "Functions",              href: "/database/functions",                category: "Database",      kind: "route" },
    { label: "Triggers",               href: "/database/triggers",                 category: "Database",      kind: "route" },
    { label: "Extensions",             href: "/database/extensions",               category: "Database",      kind: "route" },
    { label: "Roles",                  href: "/database/roles",                    category: "Database",      kind: "route" },
    { label: "Users",                  href: "/authentication/users",              category: "Auth",          kind: "route" },
    { label: "Auth Policies",          href: "/authentication/policies",           category: "Auth",          kind: "route" },
    { label: "Auth Providers",         href: "/authentication/providers",          category: "Auth",          kind: "route" },
    { label: "Auth Configuration",     href: "/authentication/configuration",      category: "Auth",          kind: "route" },
    { label: "Email Templates",        href: "/authentication/email-templates",    category: "Auth",          kind: "route" },
    { label: "Storage",                href: "/media-storage",                     category: "Storage",       kind: "route" },
    { label: "Storage Policies",       href: "/media-storage/policies",            category: "Storage",       kind: "route" },
    { label: "Edge Functions",         href: "/edge-functions",                    category: "Functions",     kind: "route" },
    { label: "Realtime",               href: "/realtime",                          category: "Realtime",      kind: "route" },
    { label: "Webhooks",               href: "/webhooks",                          category: "Platform",      kind: "route" },
    { label: "Scheduled Jobs",         href: "/jobs",                              category: "Platform",      kind: "route" },
    { label: "Logs",                   href: "/observability/logs/api",            category: "Observability", kind: "route" },
    { label: "Plugins",                href: "/plugins",                           category: "Plugins",       kind: "route" },
    { label: "REST API Docs",          href: "/api/rest",                          category: "API",           kind: "route" },
    { label: "GraphQL API Docs",       href: "/api/graphql",                       category: "API",           kind: "route" },
    { label: "Settings",               href: "/settings",                          category: "Settings",      kind: "route" },
  ]

  for (const m of models) {
    items.push({ label: m.labelPlural,          href: `/models/${m.name}`,        description: `Browse all ${m.labelPlural.toLowerCase()}`, category: "Models", kind: "route" })
    items.push({ label: `Create ${m.label}`,    href: `/models/${m.name}/create`, description: m.labelPlural,                               category: "Models", kind: "route" })
    items.push({ label: `${m.label} Schema`,    href: `/models/${m.name}/schema`, description: m.tableName,                                 category: "Models", kind: "route" })
  }

  return items
}

// ─── Live data search ─────────────────────────────────────────────────────────

function sanitiseQuery(q: string): string {
  return q.replace(/[(),]/g, "")
}

async function searchLiveData(
  client: SupatypeClient,
  models: ModelConfig[],
  rawQuery: string,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const query = sanitiseQuery(rawQuery)
  if (!query) return []

  const key = client.serviceRoleKey ?? ""
  const headers = { apikey: key, Authorization: `Bearer ${key}` }
  const q = query.toLowerCase()
  const results: SearchItem[] = []

  await Promise.allSettled([
    // Auth users — search by email and display name
    (async () => {
      const res = await fetch(`${client.url}/auth/v1/admin/users?per_page=200`, { headers, signal })
      if (!res.ok) return
      const data = await res.json() as { users?: Array<{ id: string; email?: string; user_metadata?: Record<string, unknown> }> }
      let count = 0
      for (const u of data.users ?? []) {
        const email = (u.email ?? "").toLowerCase()
        const name = String(u.user_metadata?.["name"] ?? u.user_metadata?.["full_name"] ?? "").toLowerCase()
        if (email.includes(q) || name.includes(q)) {
          const displayName = String(u.user_metadata?.["name"] ?? u.user_metadata?.["full_name"] ?? "")
          results.push({
            label: u.email ?? u.id,
            ...(displayName && { description: displayName }),
            href: "/authentication/users",
            category: "Users",
            kind: "record",
          })
          if (++count >= 5) break
        }
      }
    })(),

    // Model records — use each model's configured search fields
    ...models.slice(0, 5).map(async (model) => {
      const fields = model.searchFields.length > 0
        ? model.searchFields
        : ["name", "title", "email"]
      const orFilter = fields.map((f) => `${f}.ilike.*${query}*`).join(",")
      const res = await fetch(
        `${client.url}/rest/v1/${model.tableName}?or=(${orFilter})&select=*&limit=5`,
        { headers, signal },
      )
      if (!res.ok) return
      const rows = await res.json() as Record<string, unknown>[]
      for (const row of rows) {
        const label = String(
          row["name"] ?? row["title"] ?? row["email"] ?? row["label"] ?? row[model.primaryKey] ?? "Record",
        )
        results.push({
          label,
          description: model.label,
          href: `/models/${model.name}/${String(row[model.primaryKey])}`,
          category: model.label,
          kind: "record",
        })
      }
    }),
  ])

  return results
}

// ─── Component ────────────────────────────────────────────────────────────────

interface JumpToSearchProps {
  /** Compact variant for the header — smaller padding, narrower placeholder */
  compact?: boolean
}

export function JumpToSearch({ compact = false }: JumpToSearchProps): React.ReactElement {
  const config = useAdminConfig()
  const client = useAdminClient()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [liveResults, setLiveResults] = useState<SearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const routeItems = useMemo(() => buildRouteItems(config.models), [config.models])

  const routeMatches = useMemo((): SearchItem[] => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return routeItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q),
    ).slice(0, 5)
  }, [query, routeItems])

  // Debounced live data search
  useEffect(() => {
    if (query.trim().length < 2) {
      setLiveResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    const controller = new AbortController()

    const timer = setTimeout(() => {
      void searchLiveData(client, config.models, query.trim(), controller.signal)
        .then((items) => { if (!controller.signal.aborted) setLiveResults(items) })
        .catch(() => { /* aborted or network error */ })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
      setSearching(false)
    }
  }, [query, client, config.models])

  const results = useMemo(
    () => [...routeMatches, ...liveResults],
    [routeMatches, liveResults],
  )

  useEffect(() => { setActiveIndex(0) }, [results])

  const goTo = useCallback((href: string) => {
    navigate(href)
    setQuery("")
    setOpen(false)
    setLiveResults([])
    inputRef.current?.blur()
  }, [navigate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown")    { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === "Enter")   { const item = results[activeIndex]; if (item) goTo(item.href) }
    else if (e.key === "Escape")  { setQuery(""); setOpen(false); setLiveResults([]); inputRef.current?.blur() }
  }, [activeIndex, results, goTo])

  const inputPadding = compact ? "py-1.5" : "py-2.5"
  const placeholder = compact ? "Jump to…" : "Jump to…  (pages, users, records…)"

  const showDropdown = open && query.trim().length >= 1
  const hasResults = results.length > 0
  const noResults = !searching && query.trim().length >= 2 && results.length === 0

  // Index of first "record" result — used to draw a separator
  const firstRecordIndex = results.findIndex((r) => r.kind === "record")

  return (
    <div className="relative w-full">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
          {searching ? <SpinnerIcon /> : <SearchIcon />}
        </span>
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          className={`w-full pl-9 pr-8 ${inputPadding} rounded-lg border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-shadow`}
        />
        {query && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => { e.preventDefault(); setQuery(""); setOpen(false); setLiveResults([]) }}
          >
            <XIcon />
          </button>
        )}
      </div>

      {showDropdown && hasResults && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          {results.map((item, i) => (
            <React.Fragment key={`${item.href}-${i}`}>
              {i === firstRecordIndex && firstRecordIndex > 0 && (
                <div className="border-t border-border mx-3" />
              )}
              <button
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === activeIndex ? "bg-muted" : "hover:bg-muted/60"}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={() => goTo(item.href)}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{item.label}</span>
                  {item.description && (
                    <span className="ml-2 text-xs text-muted-foreground truncate">{item.description}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground/60 shrink-0 font-mono">{item.category}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {showDropdown && noResults && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border border-border bg-popover shadow-lg px-4 py-3">
          <p className="text-sm text-muted-foreground">No results for &ldquo;{query}&rdquo;</p>
        </div>
      )}
    </div>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function SearchIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function SpinnerIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function XIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
