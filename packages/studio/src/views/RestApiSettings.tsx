import React, { useState, useEffect } from "react"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useServerRestCacheOffered } from "../hooks/useServerRestCacheOffered.js"
import { useStudioClient } from "../StudioCore.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { Button, Card, CodeBlock, Input } from "../components/ui.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { cn } from "../lib/utils.js"

const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const

export function RestApiSettings(): React.ReactElement {
  const config = useAdminConfig()
  const client = useStudioClient()
  const serverCacheOffered = useServerRestCacheOffered()

  const apiBase = `${client.url.replace(/\/+$/, "")}/rest/v1`

  const [schema, setSchema] = useState("public")
  const [maxRows, setMaxRows] = useState("1000")
  const [cacheMaxTTL, setCacheMaxTTL] = useState("0")
  const [committed, setCommitted] = useState({ schema: "public", maxRows: "1000", cacheMaxTTL: "0" })
  const [isSaving, setIsSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    fetch(`${client.url}/admin/v1/config/rest`, {
      headers: studioAuthHeaders(client),
      credentials: "include",
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d: { schema: string; max_rows: number; cache_max_ttl?: number }) => {
        if (cancelled) return
        setSchema(d.schema ?? "public")
        setMaxRows(String(d.max_rows ?? 1000))
        setCacheMaxTTL(String(d.cache_max_ttl ?? 0))
        setCommitted({
          schema: d.schema ?? "public",
          maxRows: String(d.max_rows ?? 1000),
          cacheMaxTTL: String(d.cache_max_ttl ?? 0),
        })
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message ?? "Failed to load") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [client, retryCount])

  const isDirty =
    schema !== committed.schema ||
    maxRows !== committed.maxRows ||
    (serverCacheOffered && cacheMaxTTL !== committed.cacheMaxTTL)

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    setSavedOk(false)
    try {
      const res = await fetch(`${client.url}/admin/v1/config/rest`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...studioAuthHeaders(client),
        },
        credentials: "include",
        body: JSON.stringify({
          schema,
          max_rows: parseInt(maxRows, 10),
          ...(serverCacheOffered && { cache_max_ttl: parseInt(cacheMaxTTL, 10) || 0 }),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { message?: string }).message ?? `${res.status} ${res.statusText}`)
      }
      setCommitted({ schema, maxRows, cacheMaxTTL })
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">REST API Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          PostgREST configuration and schema exposure for your project.
        </p>
      </div>

      {loadError && (
        <div className="flex items-center gap-3">
          <ErrorBanner message={`Failed to load settings: ${loadError}`} />
          <Button size="xs" onClick={() => setRetryCount((c) => c + 1)}>Retry</Button>
        </div>
      )}

      {loading ? (
        <Card>
          <div className="px-4 py-3 border-b border-border"><div className="h-4 w-24 rounded bg-muted animate-pulse" /></div>
          <div className="divide-y divide-border">
            {[1, 2].map((i) => <div key={i} className="flex justify-between px-4 py-3"><div className="h-4 w-20 rounded bg-muted animate-pulse" /><div className="h-7 w-32 rounded bg-muted animate-pulse" /></div>)}
          </div>
        </Card>
      ) : null}

      {/* Connection */}
      <Card className={loading ? "hidden" : ""}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connection</h2>
          <div className="flex items-center gap-2">
            {saveError ? (
              <span className="text-xs text-destructive">{saveError}</span>
            ) : null}
            <Button size="xs" variant="primary" onClick={() => void handleSave()} disabled={!isDirty || isSaving}>
              {isSaving ? "Saving…" : savedOk ? "Saved!" : "Save"}
            </Button>
          </div>
        </div>
        <div className="divide-y divide-border">
          <Row label="API URL">
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">{apiBase}</code>
          </Row>
          <Row label="Schema">
            <Input
              className="w-36 text-sm font-mono"
              value={schema}
              onChange={(e) => { setSchema(e.target.value); setSaveError(null) }}
            />
          </Row>
          <Row label="Max rows">
            <div className="flex items-center gap-2">
              <Input
                className="w-24 text-sm font-mono"
                type="number"
                min={1}
                value={maxRows}
                onChange={(e) => { setMaxRows(e.target.value); setSaveError(null) }}
              />
              <span className="text-xs text-muted-foreground">per request</span>
            </div>
          </Row>
          {serverCacheOffered ? (
            <Row label="Cache max TTL">
              <div className="flex items-center gap-2">
                <Input
                  className="w-24 text-sm font-mono"
                  type="number"
                  min={0}
                  value={cacheMaxTTL}
                  onChange={(e) => { setCacheMaxTTL(e.target.value); setSaveError(null) }}
                />
                <span className="text-xs text-muted-foreground">seconds (0 = off)</span>
              </div>
            </Row>
          ) : null}
        </div>
      </Card>

      {serverCacheOffered ? (
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Response cache</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tables are uncached by default. Enable per table under each model&apos;s Cache tab or manage entries under{" "}
            <a href="/api/rest/cache" className="text-primary hover:underline">API → REST → Cache</a>.
          </p>
        </div>
      </Card>
      ) : (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <div className="px-4 py-3 space-y-2">
          <h2 className="text-sm font-semibold">Server-side cache not on Free</h2>
          <p className="text-xs text-muted-foreground">
            Cloud free tier bypasses Valkey — requests always reach PostgREST (no server in-memory cache).
            Client-only <code className="font-mono">.cache(&#123; ttl &#125;)</code> still works in your app.
            Upgrade to Pro for Valkey-backed <code className="font-mono">.cache(&#123; server: true &#125;)</code>.
          </p>
        </div>
      </Card>
      )}

      {/* Tables */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Exposed Tables</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            All schema-defined models are automatically exposed. Row-level security policies control per-row access.
          </p>
        </div>
        {config.models.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">No models defined yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Run <code className="font-mono">supatype push</code> to expose your schema.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {config.models.map((model) => (
              <div key={model.name} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{model.label}</div>
                  <code className="text-xs text-muted-foreground font-mono">/rest/v1/{model.tableName}</code>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-4">
                  {HTTP_METHODS.map((m) => (
                    <span
                      key={m}
                      className={cn(
                        "text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded",
                        m === "GET"    && "bg-green-500/15 text-green-400",
                        m === "POST"   && "bg-blue-500/15 text-blue-400",
                        m === "PATCH"  && "bg-yellow-500/15 text-yellow-400",
                        m === "DELETE" && "bg-red-500/15 text-red-400",
                      )}
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Auth */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Authentication</h2>
        </div>
        <div className="divide-y divide-border">
          <AuthRow role="anon" description="Requests without a JWT use the anon role. RLS policies control which rows are visible." />
          <AuthRow role="authenticated" description="Requests with a valid JWT use the authenticated role. User ID is available via auth.uid()." />
          <AuthRow role="service_role" description="The service role key bypasses RLS entirely. Use only in trusted server contexts." />
        </div>
      </Card>

      {/* Example */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Example Request</h2>
        </div>
        <div className="p-4">
          <CodeBlock>
            {`curl '${apiBase}/${config.models[0]?.tableName ?? "posts"}?select=*&limit=10' \\
  -H 'apikey: <anon-key>' \\
  -H 'Authorization: Bearer <jwt-token>'`}
          </CodeBlock>
        </div>
      </Card>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  )
}

function AuthRow({ role, description }: { role: string; description: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <code className="text-[11px] font-mono bg-muted px-2 py-0.5 rounded mt-0.5 shrink-0">{role}</code>
      <span className="text-sm text-muted-foreground">{description}</span>
    </div>
  )
}
