"use client"

import React from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { AdminConfigContext } from "../hooks/useAdminConfig.js"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import type { AdminConfig } from "../config.js"
import { cn } from "../lib/utils.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { Button } from "./ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem = { label: string; href: string; activeWhen?: (path: string, search: string) => boolean }
type NavGroup = { label?: string; items: NavItem[] }
type SectionDef = { title: string; groups: NavGroup[] }
interface FunctionMeta {
  name: string
}
interface StorageBucketMeta {
  id: string
  name: string
  public: boolean
}

// ─── Static section definitions ───────────────────────────────────────────────

const STATIC_SECTIONS: Record<string, SectionDef> = {
  database: {
    title: "Database",
    groups: [
      {
        items: [
          { label: "Overview",   href: "/database/overview" },
          { label: "Tables",     href: "/database/tables" },
          { label: "Views",      href: "/database/views" },
          { label: "Functions",  href: "/database/functions" },
          { label: "Triggers",   href: "/database/triggers" },
          { label: "Types",      href: "/database/types" },
          { label: "Roles",      href: "/database/roles" },
          { label: "Extensions", href: "/database/extensions" },
        ],
      },
      {
        label: "Tools",
        items: [
          { label: "SQL Runner",  href: "/database/sql" },
          { label: "Migrations",  href: "/database/migrations" },
        ],
      },
      {
        label: "Coming Soon",
        items: [
          { label: "Wrappers",    href: "/database/wrappers" },
          { label: "Replication", href: "/database/replication" },
          { label: "Warehouse",   href: "/database/warehouse" },
          { label: "Backups",     href: "/database/backups" },
        ],
      },
    ],
  },
  settings: {
    title: "Settings",
    groups: [
      {
        items: [
          { label: "General", href: "/settings" },
        ],
      },
      {
        label: "API",
        items: [
          { label: "REST", href: "/api/rest" },
          { label: "GraphQL", href: "/api/graphql" },
        ],
      },
    ],
  },
  auth: {
    title: "Authentication",
    groups: [
      {
        items: [
          { label: "Users",            href: "/authentication/users" },
          { label: "Policies",         href: "/authentication/policies" },
          { label: "Providers",        href: "/authentication/providers" },
          { label: "Configuration",    href: "/authentication/configuration" },
          { label: "Email Templates",  href: "/authentication/email-templates" },
        ],
      },
      {
        label: "Coming Soon",
        items: [
          { label: "Hooks",    href: "/authentication/hooks" },
          { label: "SSO",      href: "/authentication/sso" },
          { label: "Security", href: "/authentication/security" },
        ],
      },
    ],
  },
  storage: {
    title: "Media & Storage",
    groups: [{ items: [] }],
  },
  observability: {
    title: "Observability",
    groups: [{
      items: [
        { label: "Logs",     href: "/observability/logs" },
        { label: "Metrics",  href: "/observability/metrics" },
        { label: "Advisors", href: "/observability/advisors" },
      ],
    }],
  },
  ai: {
    title: "Intelligence",
    groups: [{
      items: [
        { label: "Usage",   href: "/ai/usage" },
        { label: "Vectors", href: "/ai/vectors" },
        { label: "RAG",     href: "/ai/rag" },
        { label: "Agents",  href: "/ai/agents/list" },
      ],
    }],
  },
  functions: {
    title: "Edge Functions",
    groups: [
      {
        items: [
          { label: "Functions", href: "/edge-functions" },
        ],
      },
    ],
  },
}

// ─── Section detection ────────────────────────────────────────────────────────

function getSectionId(path: string): string | null {
  if (path === "/models" || path.startsWith("/models/")) return "models"
  if (
    path.startsWith("/api") ||
    path === "/settings" ||
    path.startsWith("/settings/")
  ) {
    return "settings"
  }
  if (path.startsWith("/database")) return "database"
  if (path.startsWith("/authentication")) return "auth"
  if (path.startsWith("/media-storage")) return "storage"
  if (path.startsWith("/observability")) return "observability"
  if (path.startsWith("/ai")) return "ai"
  if (path.startsWith("/edge-functions")) return "functions"
  return null
}

function buildSettingsSection(): SectionDef {
  return {
    title: "Settings",
    groups: [
      {
        items: [{ label: "General", href: "/settings" }],
      },
      {
        label: "API",
        items: [
          { label: "REST", href: "/api/rest" },
          { label: "GraphQL", href: "/api/graphql" },
        ],
      },
    ],
  }
}

function buildModelsSection(config: AdminConfig | null): SectionDef {
  const modelItems = (config?.models ?? []).map((m) => ({
    label: m.labelPlural,
    href: `/models/${m.name}`,
    activeWhen: (currentPath: string) => {
      if (currentPath.startsWith("/models/globals")) return false
      const match = currentPath.match(/^\/models\/([^/]+)/)
      return match?.[1] === m.name
    },
  }))
  const globalItems = (config?.globals ?? []).map((g) => ({
    label: g.label,
    href: `/models/globals/${g.name}`,
    activeWhen: (currentPath: string) => {
      const match = currentPath.match(/^\/models\/globals\/([^/]+)/)
      return match?.[1] === g.name
    },
  }))
  const groups: NavGroup[] = [
    {
      label: "Models",
      items: modelItems.length > 0
        ? modelItems
        : [{ label: "No models yet", href: "/models" }],
    },
  ]
  if (globalItems.length > 0) {
    groups.push({ label: "Globals", items: globalItems })
  }
  return { title: "Models", groups }
}

// ─── SecondaryPanel ───────────────────────────────────────────────────────────

export function SecondaryPanel(): React.ReactElement | null {
  const location = useLocation()
  const navigate = useNavigate()
  const client = useStudioClient()
  const config = React.useContext(AdminConfigContext)
  const path = location.pathname
  const search = location.search

  const sectionId = getSectionId(path)

  const adminFetch = React.useCallback(
    (adminPath: string, init?: RequestInit) =>
      fetch(`${client.url}/functions/v1/admin${adminPath}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...studioAuthHeaders(client),
          ...init?.headers,
        },
      }),
    [client],
  )

  const { data: functionsData } = useApiQuery<FunctionMeta[]>(
    async () => {
      if (sectionId !== "functions") return []
      const res = await adminFetch("/list")
      if (!res.ok) return []
      const json = await res.json() as { data: FunctionMeta[] }
      return json.data ?? []
    },
    [sectionId, adminFetch],
  )
  const { data: storageBuckets } = useApiQuery<StorageBucketMeta[]>(
    async () => {
      if (sectionId !== "storage") return []
      const { data, error } = await client.storage.listBuckets()
      if (error) return []
      return (data ?? []) as StorageBucketMeta[]
    },
    [sectionId, client],
  )

  if (!sectionId) return null

  let section: SectionDef
  const storageMatch = path.match(/^\/media-storage\/([^/]+)\/(files|policies)$/)
  const selectedStorageBucket = storageMatch ? decodeURIComponent(storageMatch[1] ?? "") : null
  const selectedStorageTab = storageMatch?.[2] === "policies" ? "policies" : "files"

  const openCreateBucketFromSecondaryNav = () => {
    const fallbackBucket = selectedStorageBucket ?? storageBuckets?.[0]?.name
    const targetPath = fallbackBucket
      ? `/media-storage/${encodeURIComponent(fallbackBucket)}/${selectedStorageTab}`
      : "/media-storage/default/files"
    navigate(targetPath, { state: { openCreateBucket: true } })
  }

  if (sectionId === "models") {
    section = buildModelsSection(config)
  } else if (sectionId === "functions") {
    const edgeMatch = path.match(/^\/edge-functions\/([^/]+)(?:\/([^/]+))?/)
    const selectedFnSlug = edgeMatch?.[1]
    const tab = edgeMatch?.[2] === "logs"
      ? "logs"
      : edgeMatch?.[2] === "env"
        ? "env"
        : "invoke"
    const items = (functionsData ?? []).map((fn) => ({
      label: fn.name,
      href: `/edge-functions/${encodeURIComponent(fn.name)}/${tab}`,
      activeWhen: (currentPath: string) => {
        const m = currentPath.match(/^\/edge-functions\/([^/]+)/)
        return decodeURIComponent(m?.[1] ?? "") === fn.name
      },
    }))
    section = {
      title: "Edge Functions",
      groups: items.length > 0
        ? [{ items }]
        : [{ items: [{ label: "No functions yet", href: "/edge-functions" }] }],
    }
    if (!selectedFnSlug && items.length > 0) {
      // Keep panel highlight stable until view syncs URL.
      section.groups[0]!.items[0] = {
        ...section.groups[0]!.items[0]!,
        activeWhen: () => true,
      }
    }
  } else if (sectionId === "storage") {
    const tabItems = (storageBuckets ?? []).map((bucket) => ({
      label: bucket.name,
      href: `/media-storage/${encodeURIComponent(bucket.name)}/${selectedStorageTab}`,
      activeWhen: (currentPath: string) => {
        const current = currentPath.match(/^\/media-storage\/([^/]+)\/(?:files|policies)$/)
        const currentBucket = current ? decodeURIComponent(current[1] ?? "") : null
        return currentBucket === bucket.name || (!currentBucket && selectedStorageBucket === null && (storageBuckets?.[0]?.name === bucket.name))
      },
    }))
    section = {
      title: "Media & Storage",
      groups: tabItems.length > 0
        ? [{ items: tabItems }]
        : [{ items: [{ label: "No buckets yet", href: "/media-storage" }] }],
    }
  } else if (sectionId === "settings") {
    section = buildSettingsSection()
  } else {
    section = STATIC_SECTIONS[sectionId] ?? { title: "", groups: [] }
  }

  return (
    <div className="w-[200px] shrink-0 border-r border-border/80 bg-background flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 pb-2.5 border-b border-border/50 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {section.title}
        </h2>
        {sectionId === "storage" ? (
          <Button size="xs" onClick={openCreateBucketFromSecondaryNav}>New</Button>
        ) : null}
      </div>
      <nav className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: "none" }}>
        {section.groups.map((group, gi) => (
          <div key={gi} className={cn(gi > 0 && "mt-3")}>
            {group.label && (
              <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              // An item is active if the path matches or starts with it,
              // but for model items we exclude the /schema sub-route so
              // the Editor tab (not Schema tab) stays highlighted here.
              const active = item.activeWhen
                ? item.activeWhen(path, search)
                : (
                  path === item.href ||
                  path.startsWith(item.href + "/") ||
                  path.startsWith(item.href + "?")
                )
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigate(item.href)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center w-full px-4 py-1.5 text-[13px] transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    active
                      ? "text-foreground font-medium bg-accent/50"
                      : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </div>
  )
}
