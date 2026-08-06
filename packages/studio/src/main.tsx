/// <reference types="vite/client" />
import React, { useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { StudioCore } from "./StudioCore.js"
import { createClient, type SupatypeClient } from "@supatype/client"
import { mockConfig } from "./fixtures/mockConfig.js"
import { StudioConfigError, type StudioConfigErrorKind } from "./components/StudioConfigError.js"
import { StudioAccessGate } from "./components/StudioAccessGate.js"
import type { AdminConfig } from "./config.js"
import "./globals.css"
import { normalizeAdminConfig } from "./lib/normalize-admin-config.js"
import { studioAuthHeaders } from "./lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "./lib/studio-gateway-headers.js"

/** Match Vite `base` / `import.meta.env.BASE_URL` so Router history URLs include the subpath when hosted under a prefix. */
function studioBasename(): string | undefined {
  const base = import.meta.env.BASE_URL
  if (base === "/" || base === "") return undefined
  return base.endsWith("/") ? base.slice(0, -1) : base
}

const DEMO_SESSION_KEY = "supatype_studio_demo"

type RuntimeConfig = { url?: string; anonKey?: string; serviceRoleKey?: string }
const runtimeConfig: RuntimeConfig =
  (typeof window !== "undefined" &&
    (window as unknown as { __SUPATYPE_CLOUD__?: RuntimeConfig }).__SUPATYPE_CLOUD__) || {}

function resolveApiBase(): string {
  if (runtimeConfig.url) return runtimeConfig.url
  // Same-origin in the browser: works via Vite (:3002) or Kong (/studio/) without CORS.
  if (typeof window !== "undefined") return window.location.origin
  return import.meta.env.VITE_SUPATYPE_URL ?? "http://localhost:18473"
}

function resolveAnonKey(): string {
  return runtimeConfig.anonKey ?? import.meta.env.VITE_SUPATYPE_ANON_KEY ?? "dev-anon-key"
}

/**
 * Refuse a service role key in the browser.
 *
 * Studio used to accept one and skip the auth gate entirely. A key in the browser
 * is unrestricted database access to anyone who opens devtools, and it bypasses
 * every control the server now applies — Studio membership, the role's capability
 * set, the acting identity, and the audit trail. All privileged calls go through
 * `/studio/proxy`, which holds the key server-side and applies those controls.
 *
 * Ignored loudly rather than silently, so a deployment still passing one finds out
 * why it stopped working.
 */
function warnIfBrowserServiceRoleKey(): void {
  const supplied = runtimeConfig.serviceRoleKey ?? import.meta.env.VITE_SUPATYPE_SERVICE_ROLE_KEY
  if (supplied === undefined || supplied === "") return
  console.error(
    "[supatype] A service role key was supplied to Studio in the browser and has been ignored. " +
      "It grants unrestricted database access to anyone who opens devtools and bypasses Studio " +
      "membership, role permissions and the audit trail. Remove VITE_SUPATYPE_SERVICE_ROLE_KEY / " +
      "__SUPATYPE_CLOUD__.serviceRoleKey and sign in instead — privileged calls are proxied " +
      "server-side.",
  )
}

function readDemoSession(): boolean {
  try {
    return sessionStorage.getItem(DEMO_SESSION_KEY) === "1"
  } catch {
    return false
  }
}

interface StudioShellProps {
  client: SupatypeClient
  apiBaseUrl: string
  demoMode: boolean
  onEnterDemo?: (() => void) | undefined
}

function StudioShell({ client, apiBaseUrl, demoMode, onEnterDemo }: StudioShellProps): React.ReactElement {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading")
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [errorKind, setErrorKind] = useState<StudioConfigErrorKind>("unknown")
  const [errorDetail, setErrorDetail] = useState<string | undefined>()
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
    const base = apiBaseUrl.replace(/\/$/, "")

    void (async () => {
      try {
        const res = await fetch(`${base}/studio-config`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...studioGatewayHeaders(),
            ...studioAuthHeaders(client),
          },
          body: "{}",
          credentials: "omit",
        })
        const text = await res.text()
        if (cancelled) return
        if (res.ok) {
          setConfig(normalizeAdminConfig(JSON.parse(text)))
          setLoadState("ready")
          return
        }
        if (res.status === 404) {
          setErrorKind("not_pushed")
          setLoadState("error")
          return
        }
        setErrorKind("unknown")
        setErrorDetail(`HTTP_${res.status}`)
        setLoadState("error")
      } catch (e: unknown) {
        if (cancelled) return
        setErrorKind("network")
        setErrorDetail(e instanceof Error ? e.message : String(e))
        setLoadState("error")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, client, demoMode, fetchGeneration])

  const onTryDemo = (_demo: AdminConfig) => {
    try {
      sessionStorage.setItem(DEMO_SESSION_KEY, "1")
    } catch {
      /* ignore */
    }
    onEnterDemo?.()
  }

  const onRetry = () => {
    try {
      sessionStorage.removeItem(DEMO_SESSION_KEY)
    } catch {
      /* ignore */
    }
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
        baseUrl={apiBaseUrl}
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
        baseUrl={apiBaseUrl}
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

function App(): React.ReactElement {
  const apiBaseUrl = resolveApiBase()
  const anonKey = resolveAnonKey()
  const [demoMode, setDemoMode] = useState(readDemoSession)

  useEffect(warnIfBrowserServiceRoleKey, [])

  const authClient = useMemo(
    () =>
      createClient({
        url: apiBaseUrl,
        anonKey,
        auth: { storageKey: "supatype.auth.session" },
      }),
    [apiBaseUrl, anonKey],
  )

  const enterDemo = () => setDemoMode(true)

  // Demo mode never talks to a real project, so it needs no privilege at all.
  if (demoMode) {
    return <StudioShell client={authClient} apiBaseUrl={apiBaseUrl} demoMode />
  }

  // There is one path now: sign in, then every privileged call is proxied.
  return (
    <StudioAccessGate apiBaseUrl={apiBaseUrl} anonKey={anonKey} authClient={authClient}>
      {(proxyClient) => (
        <StudioShell
          client={proxyClient}
          apiBaseUrl={apiBaseUrl}
          demoMode={false}
          onEnterDemo={enterDemo}
        />
      )}
    </StudioAccessGate>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
