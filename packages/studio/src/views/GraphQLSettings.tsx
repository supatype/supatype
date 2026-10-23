import React, { useState, useEffect } from "react"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useStudioClient } from "../StudioCore.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { Button, Card, CodeBlock, Input, LoadingSettingsCard, Switch } from "../components/ui.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { cn } from "../lib/utils.js"
import { useRoleRefusalText } from "../components/RoleGate.js"
import { proxyFailure } from "../lib/role-refusal.js"
import {
  bodyMessage,
  isBoolean,
  isNumber,
  isShape,
  nullable,
  optional,
  readJson,
  readJsonObject,
} from "../lib/json.js"

/** `GET /admin/v1/config/graphql`. A key left out or null shows its default. */
const isGraphqlConfig = isShape({
  introspection: optional(nullable(isBoolean)),
  max_query_depth: optional(nullable(isNumber)),
  max_rows: optional(nullable(isNumber)),
})

const AUTH_TYPES = [
  { label: "Users",      types: "UsersNode · UsersEdge · UsersConnection" },
  { label: "Sessions",   types: "SessionsNode · SessionsEdge · SessionsConnection" },
  { label: "Identities", types: "IdentitiesNode · IdentitiesEdge · IdentitiesConnection" },
]

export function GraphQLSettings(): React.ReactElement {
  const config = useAdminConfig()
  const client = useStudioClient()
  const refused = useRoleRefusalText()

  const endpoint = `${client.url.replace(/\/+$/, "")}/graphql/v1`

  const [introspection, setIntrospection] = useState(true)
  const [maxQueryDepth, setMaxQueryDepth] = useState("10")
  const [defaultMaxRows, setDefaultMaxRows] = useState("1000")
  const [committed, setCommitted] = useState({ introspection: true, maxQueryDepth: "10", defaultMaxRows: "1000" })
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
    fetch(`${client.url}/admin/v1/config/graphql`, {
      headers: studioAuthHeaders(client),
      credentials: "include",
    })
      .then(async (r) => { if (!r.ok) throw await proxyFailure(r, refused); return readJson(r, isGraphqlConfig) })
      .then((d) => {
        if (cancelled) return
        setIntrospection(d.introspection ?? true)
        setMaxQueryDepth(String(d.max_query_depth ?? 10))
        setDefaultMaxRows(String(d.max_rows ?? 1000))
        setCommitted({ introspection: d.introspection ?? true, maxQueryDepth: String(d.max_query_depth ?? 10), defaultMaxRows: String(d.max_rows ?? 1000) })
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message ?? "Failed to load") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [client, refused, retryCount])

  const isDirty =
    introspection !== committed.introspection ||
    maxQueryDepth !== committed.maxQueryDepth ||
    defaultMaxRows !== committed.defaultMaxRows

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    setSavedOk(false)
    try {
      const res = await fetch(`${client.url}/admin/v1/config/graphql`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...studioAuthHeaders(client),
        },
        credentials: "include",
        body: JSON.stringify({
          introspection,
          max_query_depth: parseInt(maxQueryDepth, 10),
          max_rows: parseInt(defaultMaxRows, 10),
        }),
      })
      if (!res.ok) {
        const body = await readJsonObject(res)
        throw new Error(bodyMessage(body) ?? `${res.status} ${res.statusText}`)
      }
      setCommitted({ introspection, maxQueryDepth, defaultMaxRows })
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
        <h1 className="text-lg font-semibold">GraphQL Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          pg_graphql configuration and generated schema overview.
        </p>
      </div>

      {loadError && (
        <div className="flex items-center gap-3">
          <ErrorBanner message={`Failed to load settings: ${loadError}`} />
          <Button size="xs" onClick={() => setRetryCount((c) => c + 1)}>Retry</Button>
        </div>
      )}

      {loading ? (
        <LoadingSettingsCard rows={3} />
      ) : null}

      {/* Connection */}
      <Card className={loading ? "hidden" : ""}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connection</h2>
          <div className="flex items-center gap-2">
            {saveError ? (
              <span className="text-xs text-destructive-text">{saveError}</span>
            ) : null}
            <Button size="xs" variant="primary" onClick={() => void handleSave()} disabled={!isDirty || isSaving}>
              {isSaving ? "Saving…" : savedOk ? "Saved!" : "Save"}
            </Button>
          </div>
        </div>
        <div className="divide-y divide-border">
          <SettingRow label="Endpoint">
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">{endpoint}</code>
          </SettingRow>
          <SettingRow label="Engine">
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">pg_graphql</code>
          </SettingRow>
          <SettingRow label="Introspection">
            <Switch label="Introspection" checked={introspection} onChange={(on) => { setIntrospection(on); setSaveError(null) }} />
          </SettingRow>
          <SettingRow label="Max query depth">
            <Input
              className="w-20 text-sm font-mono"
              type="number"
              min={1}
              value={maxQueryDepth}
              onChange={(e) => { setMaxQueryDepth(e.target.value); setSaveError(null) }}
            />
          </SettingRow>
          <SettingRow label="Default max rows">
            <Input
              className="w-24 text-sm font-mono"
              type="number"
              min={1}
              value={defaultMaxRows}
              onChange={(e) => { setDefaultMaxRows(e.target.value); setSaveError(null) }}
            />
          </SettingRow>
        </div>
      </Card>

      {/* Generated types */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Generated Types</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            pg_graphql introspects your Postgres schema and generates these types automatically.
          </p>
        </div>
        {config.models.length === 0 ? (
          <div className="px-4 py-6 text-center border-b border-border">
            <p className="text-sm text-muted-foreground">No models defined yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run <code className="font-mono">supatype push</code> to generate GraphQL types.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {config.models.map((model) => (
              <div key={model.name} className="px-4 py-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium">{model.label}</span>
                  <div className="flex gap-1.5">
                    <span className="text-[10px] font-semibold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded font-mono">Query</span>
                    <span className="text-[10px] font-semibold bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded font-mono">Mutation</span>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground font-mono space-y-0.5">
                  <div>{model.label}Node · {model.label}Edge · {model.label}Connection</div>
                  <div>insert{model.label}One · update{model.label}ByNodeId · delete{model.label}ByNodeId</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="px-4 py-2 border-t border-border bg-muted/30">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Built-in · auth schema</span>
        </div>
        <div className="divide-y divide-border">
          {AUTH_TYPES.map((t) => (
            <div key={t.label} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium">{t.label}</span>
                <span className="text-[10px] font-semibold bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded font-mono">Query</span>
              </div>
              <div className="text-xs text-muted-foreground font-mono">{t.types}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Example */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Example Request</h2>
        </div>
        <div className="p-4">
          <CodeBlock>
            {`curl '${endpoint}' \\
  -H 'apikey: <anon-key>' \\
  -H 'Authorization: Bearer <jwt-token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"query":"{ ${config.models[0]?.tableName ?? "posts"} { edges { node { id } } } }"}'`}
          </CodeBlock>
        </div>
      </Card>
    </div>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  )
}
