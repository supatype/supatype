import React, { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import type { ModelConfig } from "../config.js"
import { SQL_EDITOR_HREF, sqlEditorOffered } from "../lib/sql-editor-access.js"
import { defaultFirstLocales } from "../lib/localized-field.js"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { IconX } from "./icons.js"
import { JUMP_PAGE_SIZE, liveRows, useLiveSearch, type SearchItem } from "./jump-live-search.js"

// ─── Static route index ───────────────────────────────────────────────────────

function buildRouteItems(models: ModelConfig[], globals: { name: string; label: string }[]): SearchItem[] {
  const items: SearchItem[] = [
    { label: "Dashboard",              href: "/",                                  category: "Core",          kind: "route" },
    { label: "Models",                 href: "/models",                            category: "Core",          kind: "route" },
    { label: "Database Overview",      href: "/database/overview",                 category: "Database",      kind: "route" },
    { label: "SQL Runner",             href: "/database/sql",                      category: "Database",      kind: "route" },
    { label: "Migrations",             href: "/database/migrations",               category: "Database",      kind: "route" },
    { label: "Schema objects",         href: "/database/objects",                  category: "Database",      kind: "route" },
    { label: "Seeds",                  href: "/database/seeds",                    category: "Database",      kind: "route" },
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

  for (const g of globals) {
    items.push({
      label: g.label,
      href: `/models/globals/${g.name}`,
      description: "Global",
      category: "Globals",
      kind: "route",
    })
  }

  return items
}

/** The routes this caller may jump to: every route, less the SQL editor for a role not offered it. */
export function jumpTargetsFor(
  capability: { role: string | null; permissions: Record<string, boolean> },
  models: ModelConfig[] = [],
  globals: { name: string; label: string }[] = [],
): SearchItem[] {
  const items = buildRouteItems(models, globals)
  return sqlEditorOffered(capability) ? items : items.filter((item) => item.href !== SQL_EDITOR_HREF)
}

// ─── Component ────────────────────────────────────────────────────────────────

interface JumpToSearchProps {
  /** Compact variant for the header, smaller padding, narrower placeholder */
  compact?: boolean
}

/** The static routes whose label, description or category holds `query`. */
function matchRoutes(routeItems: SearchItem[], query: string): SearchItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return routeItems.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q),
  )
}

/** The first `shown` page links, then a "More pages" row while there are more. They stopped at five. */
function routeRows(matches: SearchItem[], shown: number): SearchItem[] {
  if (matches.length <= shown) return matches
  const more: SearchItem = { label: `More pages (${matches.length - shown} more)`, href: "", category: "Pages", kind: "more", group: PAGES_GROUP }
  return [...matches.slice(0, shown), more]
}

const PAGES_GROUP = "pages"

interface JumpResultsProps {
  results: SearchItem[]
  activeIndex: number
  onHover: (index: number) => void
  onChoose: (item: SearchItem) => void
}

/** The dropdown's rows, with a rule above the first live result. */
function JumpResults({ results, activeIndex, onHover, onChoose }: JumpResultsProps): React.ReactElement {
  const firstLiveIndex = results.findIndex((r) => r.kind === "record" || (r.kind === "more" && r.group !== PAGES_GROUP))
  return (
    <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border border-border bg-popover shadow-lg max-h-[70vh] overflow-y-auto">
      {results.map((item, i) => (
        <React.Fragment key={`${item.kind}-${item.group ?? ""}-${item.href}-${i}`}>
          {i === firstLiveIndex && firstLiveIndex > 0 && <div className="border-t border-border mx-3" />}
          <button
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === activeIndex ? "bg-muted" : "hover:bg-muted/60"}`}
            onMouseEnter={() => onHover(i)}
            // A "More" row keeps the input focused, so the dropdown stays open for what it loads.
            onMouseDown={(e) => { if (item.kind === "more") e.preventDefault(); onChoose(item) }}
          >
            <div className="min-w-0 flex-1">
              <span className={item.kind === "more" ? "text-sm text-muted-foreground" : "text-sm font-medium text-foreground"}>{item.label}</span>
              {item.description && <span className="ml-2 text-xs text-muted-foreground truncate">{item.description}</span>}
            </div>
            <span className="text-xs text-muted-foreground/60 shrink-0 font-mono">{item.category}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export function JumpToSearch({ compact = false }: JumpToSearchProps): React.ReactElement {
  const config = useAdminConfig()
  const capability = useStudioCapability()
  const client = useAdminClient()
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Keyed by the codes, so a config re-read on focus does not search again for the same locales.
  const localeKey = defaultFirstLocales(config.locale?.defaultLocale ?? "en", config.locale?.locales ?? []).join(",")
  const locales = useMemo(() => localeKey.split(","), [localeKey])
  const live = useLiveSearch(client, config.models, query, locales)

  const routeItems = useMemo(
    () => jumpTargetsFor(capability, config.models, config.globals),
    [capability, config.models, config.globals],
  )
  const [routesShown, setRoutesShown] = useState(JUMP_PAGE_SIZE)
  const results = useMemo(
    () => [...routeRows(matchRoutes(routeItems, query), routesShown), ...liveRows(live.groups)],
    [routeItems, query, routesShown, live.groups],
  )

  useEffect(() => {
    setActiveIndex(0)
    setRoutesShown(JUMP_PAGE_SIZE)
  }, [query])

  const close = useCallback(() => {
    setQuery("")
    setOpen(false)
    inputRef.current?.blur()
  }, [])

  const choose = useCallback((item: SearchItem) => {
    if (item.kind === "more") {
      if (item.group === PAGES_GROUP) setRoutesShown((n) => n + JUMP_PAGE_SIZE)
      else if (item.group !== undefined) live.loadMore(item.group)
      return
    }
    navigate(item.href)
    close()
  }, [live, navigate, close])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown")    { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === "Enter")   { const item = results[activeIndex]; if (item) choose(item) }
    else if (e.key === "Escape")  close()
  }, [activeIndex, results, choose, close])

  const inputPadding = compact ? "py-1.5" : "py-2.5"
  const placeholder = compact ? "Jump to…" : "Jump to…  (pages, users, records…)"

  const showDropdown = open && query.trim().length >= 1
  const noResults = !live.searching && query.trim().length >= 2 && results.length === 0

  return (
    <div className="relative w-full">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
          {live.searching ? <SpinnerIcon /> : <SearchIcon />}
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
            onMouseDown={(e) => { e.preventDefault(); setQuery(""); setOpen(false) }}
          >
            <IconX />
          </button>
        )}
      </div>

      {showDropdown && results.length > 0 && (
        <JumpResults results={results} activeIndex={activeIndex} onHover={setActiveIndex} onChoose={choose} />
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

