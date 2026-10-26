import React, { useState } from "react"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js"
import { Badge, Button, Card, IconButton, Input, Pager, Skeleton, Tabs, TextLink, type TabsSpec } from "../components/ui.js"
import { IconCheck, IconCopy } from "../components/icons.js"
import { type Guard, isArrayOf, isNumber, isShape, isString, optional, readJson } from "../lib/json.js"

// ─── Types ────────────────────────────────────────────────────────────────────

/** The parts of an npm search result the card shows. npm omits a description or keywords a package lacks. */
interface NpmPackage {
  name: string
  version: string
  description?: string
  keywords?: string[]
  links: { npm: string }
  date: string
  downloads?: { weekly: number }
}

interface NpmSearchResult {
  package: NpmPackage
}

const isNpmPackage: Guard<NpmPackage> = isShape({
  name: isString,
  version: isString,
  description: optional(isString),
  keywords: optional(isArrayOf(isString)),
  links: isShape({ npm: isString }),
  date: isString,
  downloads: optional(isShape({ weekly: isNumber })),
})

const isNpmSearch = isShape({ objects: isArrayOf(isShape({ package: isNpmPackage })), total: isNumber })

/** Results per page; npm's search allows up to 250. */
const PLUGINS_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

/** One page of npm's search for `text` (zero based `page`), and how many results there are in all. */
async function searchPlugins(text: string, page: number): Promise<{ objects: NpmSearchResult[]; total: number }> {
  const params = new URLSearchParams({ text, size: String(PLUGINS_PAGE_SIZE), from: String(page * PLUGINS_PAGE_SIZE) })
  const res = await fetch(`https://registry.npmjs.org/-/v1/search?${params.toString()}`)
  if (!res.ok) throw new Error("Failed to fetch plugins from npm registry")
  return readJson(res, isNpmSearch)
}

const PLUGIN_KINDS = ["field", "composite", "provider", "widget"] as const
const CATEGORIES = ["all", ...PLUGIN_KINDS] as const

type PluginCategory = (typeof CATEGORIES)[number]

const CATEGORY_LABELS: Record<PluginCategory, string> = {
  all: "All",
  field: "Field Types",
  composite: "Composites",
  provider: "Providers",
  widget: "Widgets",
}

/** The category filter, as segmented tabs. */
const CATEGORY_TABS: TabsSpec<PluginCategory> = {
  label: "Plugin category",
  items: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
  look: "pill",
  size: "xs",
}

const CATEGORY_KEYWORDS: Record<Exclude<PluginCategory, "all">, string> = {
  field: "supatype-plugin-field",
  composite: "supatype-plugin-composite",
  provider: "supatype-plugin-provider",
  widget: "supatype-plugin-widget",
}

function detectCategory(keywords: string[]): Exclude<PluginCategory, "all"> | null {
  return PLUGIN_KINDS.find((kind) => keywords.includes(CATEGORY_KEYWORDS[kind])) ?? null
}

// ─── Skeleton cards ───────────────────────────────────────────────────────────

function SkeletonCard(): React.ReactElement {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-3">
        <Skeleton className="h-4 w-32 bg-accent rounded" />
        <Skeleton className="h-5 w-12 bg-accent rounded-full" />
      </div>
      <Skeleton className="h-3 w-full bg-accent rounded mb-1.5" />
      <Skeleton className="h-3 w-3/4 bg-accent rounded mb-4" />
      <Skeleton className="h-8 w-full bg-accent rounded" />
    </Card>
  )
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard()

  return (
    <IconButton label="Copy to clipboard" onClick={() => copy(text)}>
      {copied ? <span className="text-green-400"><IconCheck size={13} /></span> : <IconCopy size={13} />}
    </IconButton>
  )
}

// ─── Plugin card ──────────────────────────────────────────────────────────────

function PluginCard({ pkg }: { pkg: NpmPackage }): React.ReactElement {
  const category = detectCategory(pkg.keywords ?? [])
  const installCmd = `npx supatype plugins add ${pkg.name}`
  const publishedDate = new Date(pkg.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })

  const categoryVariant: Record<string, "blue" | "indigo" | "green" | "yellow"> = {
    field: "blue",
    composite: "indigo",
    provider: "green",
    widget: "yellow",
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground leading-tight truncate">{pkg.name}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">v{pkg.version}</p>
        </div>
        {category && (
          <Badge variant={categoryVariant[category] ?? "blue"} className="shrink-0 capitalize">
            {CATEGORY_LABELS[category]}
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed min-h-[2.5rem]">
        {pkg.description || "No description provided."}
      </p>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>Published {publishedDate}</span>
        {pkg.downloads && (
          <span>{pkg.downloads.weekly.toLocaleString()}/wk</span>
        )}
      </div>

      <div className="flex items-center gap-1 bg-muted rounded px-2 py-1.5">
        <code className="flex-1 text-[11px] font-mono text-foreground truncate">{installCmd}</code>
        <CopyButton text={installCmd} />
      </div>

      <TextLink href={pkg.links.npm} target="_blank" rel="noopener noreferrer" className="text-[11px]">
        View on npm
      </TextLink>
    </Card>
  )
}

// ─── PluginsMarketplace ───────────────────────────────────────────────────────

export function PluginsMarketplace(): React.ReactElement {
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<PluginCategory>("all")

  const searchQuery = category === "all"
    ? `keywords:supatype-plugin${search ? ` ${search}` : ""}`
    : `keywords:supatype-plugin keywords:${CATEGORY_KEYWORDS[category]}${search ? ` ${search}` : ""}`

  // Searched once typing pauses, and a page at a time: it showed npm's first 50 and stopped.
  const text = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS)
  const [paging, setPaging] = useState({ text, page: 0 })
  // A new search starts from its first page.
  const page = paging.text === text ? paging.page : 0
  const { data, loading, error, refetch } = useApiQuery(() => searchPlugins(text, page), [text, page])

  const packages = data?.objects ?? []

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-base font-semibold text-foreground mb-1">Plugins Marketplace</h1>
        <p className="text-sm text-muted-foreground">
          Extend your project with community and first-party plugins from npm.
        </p>
      </div>

      {/* Search + category filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <Input
            type="text"
            aria-label="Search plugins"
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <Tabs tabs={CATEGORY_TABS} value={category} onChange={setCategory} />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive-text flex items-center justify-between">
          <span>Failed to load plugins: {error}</span>
          <Button size="xs" onClick={refetch}>Retry</Button>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {loading
          ? Array.from({ length: 12 }).map((_, i) => <SkeletonCard key={i} />)
          : packages.map(({ package: pkg }) => (
              <PluginCard key={pkg.name} pkg={pkg} />
            ))
        }
      </div>

      {data !== null && data.total > PLUGINS_PAGE_SIZE && (
        <Pager at={{ page, pageSize: PLUGINS_PAGE_SIZE, total: data.total }} onPage={(p) => setPaging({ text, page: p })} busy={loading} />
      )}

      {!loading && !error && packages.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm font-medium text-foreground mb-1">No plugins found</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            {search
              ? `No plugins matching "${search}". Try a different search term.`
              : "No plugins are published yet. Publish yours with the keyword supatype-plugin."}
          </p>
        </div>
      )}
    </div>
  )
}
