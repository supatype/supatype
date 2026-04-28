import React, { useState } from "react"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../components/ui.js"
import { cn } from "../lib/utils.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface NpmPackage {
  name: string
  version: string
  description: string
  keywords: string[]
  links: { npm: string }
  publisher: { username: string }
  date: string
  downloads?: { weekly: number }
}

interface NpmSearchResult {
  package: NpmPackage
  score: { final: number }
}

type PluginCategory = "all" | "field" | "composite" | "provider" | "widget"

const CATEGORY_LABELS: Record<PluginCategory, string> = {
  all: "All",
  field: "Field Types",
  composite: "Composites",
  provider: "Providers",
  widget: "Widgets",
}

const CATEGORY_KEYWORDS: Record<Exclude<PluginCategory, "all">, string> = {
  field: "supatype-plugin-field",
  composite: "supatype-plugin-composite",
  provider: "supatype-plugin-provider",
  widget: "supatype-plugin-widget",
}

function detectCategory(keywords: string[]): Exclude<PluginCategory, "all"> | null {
  for (const [cat, kw] of Object.entries(CATEGORY_KEYWORDS) as [Exclude<PluginCategory, "all">, string][]) {
    if (keywords.includes(kw)) return cat
  }
  return null
}

// ─── Skeleton cards ───────────────────────────────────────────────────────────

function SkeletonCard(): React.ReactElement {
  return (
    <Card className="p-4 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="h-4 w-32 bg-accent rounded" />
        <div className="h-5 w-12 bg-accent rounded-full" />
      </div>
      <div className="h-3 w-full bg-accent rounded mb-1.5" />
      <div className="h-3 w-3/4 bg-accent rounded mb-4" />
      <div className="h-8 w-full bg-accent rounded" />
    </Card>
  )
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

// ─── Plugin card ──────────────────────────────────────────────────────────────

function PluginCard({ pkg }: { pkg: NpmPackage }): React.ReactElement {
  const category = detectCategory(pkg.keywords)
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

      <a
        href={pkg.links.npm}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-primary hover:underline"
      >
        View on npm
      </a>
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

  const { data, loading, error, refetch } = useApiQuery<NpmSearchResult[]>(
    async () => {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=50`
      const res = await fetch(url)
      if (!res.ok) throw new Error("Failed to fetch plugins from npm registry")
      const json = await res.json() as { objects: NpmSearchResult[] }
      return json.objects
    },
    [searchQuery],
  )

  const packages = data ?? []

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
          <input
            type="text"
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn(
              "w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background",
              "focus:outline-none focus:ring-2 focus:ring-ring",
            )}
          />
        </div>

        <div className="flex gap-1">
          {(Object.keys(CATEGORY_LABELS) as PluginCategory[]).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md transition-colors",
                category === cat
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center justify-between">
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
