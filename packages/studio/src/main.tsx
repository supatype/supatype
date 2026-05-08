/// <reference types="vite/client" />
import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { StudioCore } from "./StudioCore.js"
import { createClient } from "@supatype/client"
import { mockConfig } from "./fixtures/mockConfig.js"
import { StudioConfigError, type StudioConfigErrorKind } from "./components/StudioConfigError.js"
import type { AdminConfig, FieldConfig, GlobalConfig, NavGroup } from "./config.js"
import "./globals.css"
import { studioGatewayHeaders } from "./lib/studio-gateway-headers.js"

/** Match Vite `base` / `import.meta.env.BASE_URL` so Router history URLs include the subpath when hosted under a prefix. */
function studioBasename(): string | undefined {
  const base = import.meta.env.BASE_URL
  if (base === "/" || base === "") return undefined
  return base.endsWith("/") ? base.slice(0, -1) : base
}

const DEMO_SESSION_KEY = "supatype_studio_demo"

const client = createClient({
  url: import.meta.env.VITE_SUPATYPE_URL ?? "http://localhost:18473",
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY ?? "dev-anon-key",
  ...(import.meta.env.VITE_SUPATYPE_SERVICE_ROLE_KEY !== undefined && {
    serviceRoleKey: import.meta.env.VITE_SUPATYPE_SERVICE_ROLE_KEY,
  }),
})

// ── Engine → Studio config normalizer ────────────────────────────────────────
// The engine's admin-config.json uses slightly different field names and omits
// some studio-expected fields. This bridges the gap without changing the engine.

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function pluralize(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word + "es"
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies"
  return word + "s"
}

/** Map engine `widget` strings to `WidgetType`. Most are lowercase; `derivedText` stays camelCase to match `FieldWidget`. */
function normalizeStudioWidget(widget: unknown): FieldConfig["widget"] {
  const raw = String(widget ?? "text")
  if (raw.toLowerCase() === "derivedtext") return "derivedText"
  return raw.toLowerCase() as FieldConfig["widget"]
}

function normalizeAdminConfig(raw: unknown): AdminConfig {
  const r = raw as Record<string, unknown>

  const models = ((r["models"] as unknown[]) ?? []).map((m) => {
    const mo = m as Record<string, unknown>
    const name = String(mo["name"] ?? "")
    const label = humanize(name)
    const fields: FieldConfig[] = ((mo["fields"] as unknown[]) ?? []).map((f) => {
      const fi = f as Record<string, unknown>
      return {
        name: String(fi["name"] ?? ""),
        label: String(fi["label"] ?? humanize(String(fi["name"] ?? ""))),
        widget: normalizeStudioWidget(fi["widget"]),
        required: Boolean(fi["required"] ?? false),
        localized: Boolean(fi["localized"] ?? false),
        // engine uses showInList; studio uses listColumn
        ...(fi["showInList"] !== undefined ? { listColumn: Boolean(fi["showInList"]) } : {}),
        ...(fi["listColumn"] !== undefined ? { listColumn: Boolean(fi["listColumn"]) } : {}),
        ...(fi["sortable"] !== undefined ? { sortable: Boolean(fi["sortable"]) } : {}),
        ...(fi["filterable"] !== undefined ? { filterable: Boolean(fi["filterable"]) } : {}),
        ...(fi["options"] !== undefined ? { options: fi["options"] as Record<string, unknown> } : {}),
        ...(fi["readOnly"] !== undefined ? { readOnly: Boolean(fi["readOnly"]) } : {}),
        ...(fi["hidden"] !== undefined ? { hidden: Boolean(fi["hidden"]) } : {}),
      }
    })
    return {
      name,
      label,
      labelPlural: pluralize(label),
      tableName: String(mo["tableName"] ?? name),
      apiPath: `/rest/v1/${String(mo["tableName"] ?? name)}`,
      primaryKey: String(mo["primaryKey"] ?? "id"),
      fields,
      listColumns: (mo["listColumns"] as string[]) ?? [],
      searchFields: (mo["searchFields"] as string[]) ?? [],
      // engine uses "publishing"; studio uses "publishable"
      publishable: Boolean(mo["publishable"] ?? mo["publishing"] ?? false),
      versioning: Boolean(mo["versioning"] ?? false),
      softDelete: Boolean(mo["softDelete"] ?? false),
      timestamps: Boolean(mo["timestamps"] ?? false),
      hasHooks: Boolean(mo["hasHooks"] ?? false),
    }
  })

  const globals: GlobalConfig[] = ((r["globals"] as unknown[]) ?? []).map((g) => {
    const go = g as Record<string, unknown>
    const name = String(go["name"] ?? "")
    return {
      name,
      label: String(go["label"] ?? humanize(name)),
      tableName: String(go["tableName"] ?? `_global_${name}`),
      apiPath: `/rest/v1/_global_${name}`,
      fields: [],
    }
  })

  // Engine navigation: { group, items: [{ label, model }] }
  // Studio navigation: { label, items: [{ label, href, type }] }
  const rawNav = (r["navigation"] as unknown[]) ?? []
  let navigation: NavGroup[]
  if (rawNav.length > 0 && typeof (rawNav[0] as Record<string, unknown>)["group"] === "string") {
    navigation = rawNav.map((g) => {
      const gr = g as Record<string, unknown>
      return {
        label: String(gr["group"] ?? ""),
        items: ((gr["items"] as unknown[]) ?? []).map((it) => {
          const i = it as Record<string, unknown>
          const modelName = String(i["model"] ?? "")
          const found = models.find((mo) => mo.name === modelName)
          return {
            label: String(i["label"] ?? found?.label ?? humanize(modelName)),
            href: `/models/${modelName}`,
            type: "model" as const,
          }
        }),
      }
    })
  } else if (rawNav.length > 0) {
    navigation = rawNav as NavGroup[]
  } else {
    navigation = [{
      label: "Content",
      items: models.map((mo) => ({ label: mo.labelPlural, href: `/models/${mo.name}`, type: "model" as const })),
    }]
  }

  const rawLocale = r["localization"] as Record<string, unknown> | undefined
  const locale = rawLocale ? {
    locales: ((rawLocale["locales"] as string[]) ?? ["en"]).map((code) => ({
      code,
      label: code.toUpperCase(),
    })),
    defaultLocale: String(rawLocale["defaultLocale"] ?? "en"),
  } : undefined

  return { models, globals, navigation, ...(locale !== undefined ? { locale } : {}) }
}

function readDemoSession(): boolean {
  try {
    return sessionStorage.getItem(DEMO_SESSION_KEY) === "1"
  } catch {
    return false
  }
}

function App(): React.ReactElement {
  const baseUrl = import.meta.env.VITE_SUPATYPE_URL ?? "http://localhost:18473"
  const [demoMode, setDemoMode] = useState(readDemoSession)
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading")
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [errorKind, setErrorKind] = useState<StudioConfigErrorKind>("unknown")
  const [errorDetail, setErrorDetail] = useState<string | undefined>()
  /** Bumped on Retry to re-run live fetch after clearing demo */
  const [fetchGeneration, setFetchGeneration] = useState(0)

  useEffect(() => {
    if (demoMode) {
      setConfig(mockConfig)
      setLoadState("ready")
      return
    }

    setLoadState("loading")
    setErrorDetail(undefined)

    let cancelled = false
    fetch(`${baseUrl}/studio-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...studioGatewayHeaders() },
      body: "{}",
      credentials: "omit",
    })
      .then(async (res) => {
        const text = await res.text()
        if (res.ok) {
          return normalizeAdminConfig(JSON.parse(text))
        }
        if (res.status === 404) {
          throw new Error("NOT_PUSHED")
        }
        throw new Error(`HTTP_${res.status}`)
      })
      .then((c) => {
        if (cancelled) return
        setConfig(c)
        setLoadState("ready")
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === "NOT_PUSHED") {
          setErrorKind("not_pushed")
        } else if (msg.startsWith("HTTP_")) {
          setErrorKind("unknown")
          setErrorDetail(msg)
        } else {
          setErrorKind("network")
          setErrorDetail(msg)
        }
        setLoadState("error")
      })

    return () => {
      cancelled = true
    }
  }, [baseUrl, demoMode, fetchGeneration])

  const onTryDemo = (demo: AdminConfig) => {
    try {
      sessionStorage.setItem(DEMO_SESSION_KEY, "1")
    } catch {
      /* ignore */
    }
    setDemoMode(true)
    setConfig(demo)
    setLoadState("ready")
  }

  const onRetry = () => {
    try {
      sessionStorage.removeItem(DEMO_SESSION_KEY)
    } catch {
      /* ignore */
    }
    setDemoMode(false)
    setConfig(null)
    setLoadState("loading")
    setErrorDetail(undefined)
    setFetchGeneration((g) => g + 1)
  }

  if (loadState === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-muted-foreground text-sm">Loading Studio…</div>
      </div>
    )
  }

  if (loadState === "error") {
    return (
      <StudioConfigError
        kind={errorKind}
        baseUrl={baseUrl}
        {...(errorDetail !== undefined ? { message: errorDetail } : {})}
        onRetry={onRetry}
        onTryDemo={onTryDemo}
        demoConfig={mockConfig}
      />
    )
  }

  if (!config) {
    return (
      <StudioConfigError
        kind="unknown"
        baseUrl={baseUrl}
        message="Config is empty."
        onRetry={onRetry}
        onTryDemo={onTryDemo}
        demoConfig={mockConfig}
      />
    )
  }

  const basename = studioBasename()
  return (
    <BrowserRouter {...(basename !== undefined ? { basename } : {})}>
      <StudioCore config={config} client={client} demoMode={demoMode} />
    </BrowserRouter>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
