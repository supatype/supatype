import React, { useState, useCallback, useEffect } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { usePlatformFetch, usePlatform } from "../hooks/usePlatform.js"
import { CloudUpsell } from "./CloudUpsell.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string
  name: string
  role: "anon" | "service_role"
  key: string
  created_at: string
  last_used: string | null
}

interface EnvVar {
  key: string
  value: string
  sensitive: boolean
  source: "env" | "config" | "override"
}

interface CorsOrigin {
  id: string
  origin: string
  created_at: string
}

interface AuthProviderConfig {
  provider: string
  enabled: boolean
  client_id: string
  client_secret_set: boolean
  scopes: string
}

type SettingsTab = "general" | "keys" | "env" | "cors" | "database" | "integrations" | "danger"

// ─── General Settings Tab ─────────────────────────────────────────────────────

function GeneralSettings(): React.ReactElement {
  const client = useStudioClient()
  const adminConfig = useAdminConfig()
  const [projectName, setProjectName] = useState(adminConfig.branding?.appName ?? "")
  const [siteUrl, setSiteUrl] = useState("")
  const [dbUrl] = useState(client.url.replace(/\/rest\/v1\/?$/, ""))
  const [apiUrl] = useState(client.url)
  const [region] = useState("")
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card className="p-4">
      <h3>Project Configuration</h3>
      <div className="flex flex-col gap-4 max-w-[600px] mt-4">
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Project Name</label>
          <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Site URL</label>
          <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          <p className="text-xs text-zinc-600 mt-1">Used for email templates and OAuth redirect URLs.</p>
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Database URL</label>
          <Input className="text-muted-foreground" value={dbUrl} readOnly />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">API URL</label>
          <Input className="text-muted-foreground" value={apiUrl} readOnly />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Region</label>
          <Input className="text-muted-foreground" value={region} readOnly />
          <p className="text-xs text-zinc-600 mt-1">Region cannot be changed after project creation.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={handleSave}>Save Changes</Button>
          {saved ? <span className="text-green-400 text-xs">Saved</span> : null}
        </div>
      </div>
    </Card>
  )
}

// ─── API Keys Tab ─────────────────────────────────────────────────────────────

function ApiKeysSettings(): React.ReactElement {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [showKeys, setShowKeys] = useState(false)
  const [showNewKeyForm, setShowNewKeyForm] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [newKeyRole, setNewKeyRole] = useState<"anon" | "service_role">("anon")
  const [copied, setCopied] = useState<string | null>(null)
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null)

  const copyToClipboard = (text: string, keyId: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(keyId)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleCreateKey = () => {
    if (!newKeyName.trim()) return
    const newKey: ApiKey = {
      id: `k-${Date.now()}`,
      name: newKeyName.trim(),
      role: newKeyRole,
      key: `eyJ...new-key-${Date.now()}`,
      created_at: new Date().toISOString(),
      last_used: null,
    }
    setKeys((prev) => [...prev, newKey])
    setShowNewKeyForm(false)
    setNewKeyName("")
  }

  const handleRevokeKey = (keyId: string) => {
    setKeys((prev) => prev.filter((k) => k.id !== keyId))
    setRevokeConfirm(null)
  }

  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="m-0">API Keys</h3>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowKeys(!showKeys)}>
            {showKeys ? "Hide Keys" : "Show Keys"}
          </Button>
          <Button size="sm" variant="primary" onClick={() => setShowNewKeyForm(true)}>
            Generate New Key
          </Button>
        </div>
      </div>

      {/* New key form */}
      {showNewKeyForm ? (
        <Card className="p-3 mb-4 bg-accent/30">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-[0.8rem] text-muted-foreground mb-1">Key Name</label>
              <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="My API Key" />
            </div>
            <div className="w-[160px]">
              <label className="block text-[0.8rem] text-muted-foreground mb-1">Role</label>
              <Select className="w-full" value={newKeyRole} onChange={(e) => setNewKeyRole(e.target.value as "anon" | "service_role")}>
                <option value="anon">anon (public)</option>
                <option value="service_role">service_role (secret)</option>
              </Select>
            </div>
            <Button variant="primary" onClick={handleCreateKey}>Generate</Button>
            <Button onClick={() => setShowNewKeyForm(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {/* Key list */}
      <div className="flex flex-col gap-4">
        {keys.length === 0 ? (
          <EmptyState
            title="API keys are managed via the cloud dashboard"
            description="Live API key management will be available in a future release."
          />
        ) : keys.map((k) => (
          <div key={k.id} className="border border-border rounded-md p-4">
            <div className="flex justify-between items-start mb-2">
              <div>
                <span className="font-medium text-sm">{k.name}</span>
                <Badge
                  variant={k.role === "service_role" ? "red" : "green"}
                  className="ml-2"
                >
                  {k.role}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                Created: {new Date(k.created_at).toLocaleDateString()}
                {k.last_used ? ` | Last used: ${new Date(k.last_used).toLocaleDateString()}` : ""}
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-xs"
                value={showKeys ? k.key : "\u2022".repeat(40)}
                readOnly
              />
              <Button size="sm" onClick={() => copyToClipboard(k.key, k.id)}>
                {copied === k.id ? "Copied!" : "Copy"}
              </Button>
              {revokeConfirm === k.id ? (
                <div className="flex gap-1 items-center">
                  <Button size="sm" variant="destructive" onClick={() => handleRevokeKey(k.id)}>Confirm</Button>
                  <Button size="sm" onClick={() => setRevokeConfirm(null)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="destructive" onClick={() => setRevokeConfirm(k.id)}>Revoke</Button>
              )}
            </div>
            {k.role === "service_role" ? (
              <p className="text-xs text-red-400 mt-1">
                This key bypasses Row Level Security. Never expose in client code.
              </p>
            ) : (
              <p className="text-xs text-zinc-600 mt-1">
                Safe for client-side use. Data is protected by RLS policies.
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── Environment Variables Tab ────────────────────────────────────────────────

function EnvSettings(): React.ReactElement {
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [showAddForm, setShowAddForm] = useState(false)
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [newSensitive, setNewSensitive] = useState(false)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleEditStart = (envVar: EnvVar) => {
    setEditingKey(envVar.key)
    setEditValue(envVar.value)
  }

  const handleEditSave = () => {
    if (!editingKey) return
    setEnvVars((prev) => prev.map((v) => v.key === editingKey ? { ...v, value: editValue } : v))
    setEditingKey(null)
  }

  const handleAdd = () => {
    if (!newKey.trim()) return
    setEnvVars((prev) => [...prev, { key: newKey.trim(), value: newValue, sensitive: newSensitive, source: "override" }])
    setShowAddForm(false)
    setNewKey("")
    setNewValue("")
    setNewSensitive(false)
  }

  const handleDelete = (key: string) => {
    setEnvVars((prev) => prev.filter((v) => v.key !== key))
  }

  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="m-0">Environment Variables</h3>
          <p className="text-[0.8rem] text-muted-foreground mt-1">
            Configure environment variables for your project services.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowAddForm(true)}>+ Add Variable</Button>
      </div>

      {/* Add form */}
      {showAddForm ? (
        <Card className="p-3 mb-4 bg-accent/30">
          <div className="flex gap-2 items-end flex-wrap">
            <div className="w-[200px]">
              <label className="block text-[0.8rem] text-muted-foreground mb-1">Key</label>
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="MY_VAR" />
            </div>
            <div className="flex-1">
              <label className="block text-[0.8rem] text-muted-foreground mb-1">Value</label>
              <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" />
            </div>
            <label className="flex items-center gap-1 text-xs text-muted-foreground pb-1.5">
              <input type="checkbox" checked={newSensitive} onChange={(e) => setNewSensitive(e.target.checked)} />
              Sensitive
            </label>
            <Button variant="primary" onClick={handleAdd}>Add</Button>
            <Button onClick={() => setShowAddForm(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {envVars.length === 0 ? (
        <EmptyState
          title="Environment variables are managed via the cloud dashboard or CLI"
          description="Live configuration management will be available in a future release."
        />
      ) : (
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Key</Th>
                <Th>Value</Th>
                <Th>Source</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {envVars.map((v) => (
                <tr key={v.key} className="border-b border-border hover:bg-accent/50">
                  <td className="px-3 py-2 text-sm">
                    <code className="text-primary">{v.key}</code>
                    {v.sensitive ? <Badge variant="red" className="ml-1.5 text-[0.5rem]">secret</Badge> : null}
                  </td>
                  <td className="px-3 py-2">
                    {editingKey === v.key ? (
                      <div className="flex gap-1">
                        <Input
                          className="flex-1 font-mono text-xs"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleEditSave(); if (e.key === "Escape") setEditingKey(null) }}
                          autoFocus
                        />
                        <Button size="xs" onClick={handleEditSave}>Save</Button>
                        <Button size="xs" onClick={() => setEditingKey(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <code className="font-mono text-xs">
                        {v.sensitive && !revealedKeys.has(v.key) ? "\u2022".repeat(20) : v.value}
                      </code>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={v.source === "env" ? "blue" : v.source === "config" ? "green" : "yellow"} className="text-[0.6rem]">
                      {v.source}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {v.sensitive ? (
                        <Button size="xs" onClick={() => toggleReveal(v.key)}>
                          {revealedKeys.has(v.key) ? "Hide" : "Show"}
                        </Button>
                      ) : null}
                      <Button size="xs" onClick={() => handleEditStart(v)}>Edit</Button>
                      {v.source === "override" ? (
                        <Button size="xs" variant="destructive" onClick={() => handleDelete(v.key)}>Remove</Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Card>
  )
}

// ─── CORS Origins Tab ─────────────────────────────────────────────────────────

const CORS_OPEN_BANNER_LS_PREFIX = "supatype-studio:cors-open-banner-dismissed"

function corsOpenBannerStorageKey(projectRef: string): string {
  return `${CORS_OPEN_BANNER_LS_PREFIX}:${projectRef}`
}

function CorsSettings({ demoMode }: { demoMode: boolean }): React.ReactElement {
  const pf = usePlatformFetch()
  const { projectRef } = usePlatform()
  const [origins, setOrigins] = useState<CorsOrigin[]>([])
  const [newOrigin, setNewOrigin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle")
  /** Raw value from GET config — undefined cors key means platform permissive default */
  const [serverAllowedSnapshot, setServerAllowedSnapshot] = useState<string[] | undefined>(undefined)
  const [configReady, setConfigReady] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const refKey = typeof projectRef === "string" && projectRef.length > 0 ? projectRef : ""

  useEffect(() => {
    if (!refKey || typeof window === "undefined") return
    try {
      setBannerDismissed(localStorage.getItem(corsOpenBannerStorageKey(refKey)) === "1")
    } catch {
      setBannerDismissed(false)
    }
  }, [refKey])

  const loadConfig = useCallback(async () => {
    if (!pf || !projectRef) return
    setLoading(true)
    setLoadError(null)
    setConfigReady(false)
    try {
      const res = await pf(`projects/${projectRef}/config`)
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = (await res.json()) as { data?: Record<string, unknown> }
      const data = json.data ?? {}
      const corsVal = data["cors"] as { allowedOrigins?: unknown } | undefined
      const raw = corsVal?.allowedOrigins
      const allowedList =
        raw === undefined ? undefined : Array.isArray(raw) && raw.every((x) => typeof x === "string")
          ? (raw as string[])
          : []

      setServerAllowedSnapshot(allowedList)

      const list =
        allowedList ??
        ([] as string[]) // permissive unset: show empty editable list locally
      setOrigins(
        list.map((origin, idx) => ({
          id: `c-${origin}-${idx}`,
          origin,
          created_at: new Date().toISOString(),
        })),
      )
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load CORS configuration")
    } finally {
      setLoading(false)
      setConfigReady(true)
    }
  }, [pf, projectRef])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const permissiveUnset = serverAllowedSnapshot === undefined
  const savedListHasStar =
    Array.isArray(serverAllowedSnapshot) && serverAllowedSnapshot.includes("*")
  const showOpenBanner =
    configReady &&
    !bannerDismissed &&
    (permissiveUnset || savedListHasStar)

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true)
    if (refKey && typeof window !== "undefined") {
      try {
        localStorage.setItem(corsOpenBannerStorageKey(refKey), "1")
      } catch {
        /* ignore */
      }
    }
  }, [refKey])

  const handleAdd = () => {
    const trimmed = newOrigin.trim()
    if (!trimmed) return
    try {
      if (trimmed !== "*") new URL(trimmed) // validate URL format
    } catch {
      setError("Invalid origin URL. Must be a valid URL (e.g. https://my-app.com) or *")
      return
    }
    if (origins.some((o) => o.origin === trimmed)) {
      setError("This origin already exists")
      return
    }
    setOrigins((prev) => [...prev, { id: `c-${Date.now()}`, origin: trimmed, created_at: new Date().toISOString() }])
    setNewOrigin("")
    setError(null)
  }

  const handleRemove = (id: string) => {
    setOrigins((prev) => prev.filter((o) => o.id !== id))
  }

  const handleSave = async () => {
    if (!pf || !projectRef) return
    setSaveState("saving")
    setError(null)
    try {
      const allowedOrigins = origins.map((o) => o.origin)
      const res = await pf(`projects/${projectRef}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cors: { allowedOrigins } }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(body.message ?? `Save failed (${res.status})`)
      }
      await loadConfig()
      setSaveState("saved")
      setTimeout(() => { setSaveState("idle") }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
      setSaveState("idle")
    }
  }

  if (demoMode || !pf || !projectRef) {
    return (
      <CloudUpsell
        title="CORS configuration"
        description="Save allowed browser origins for your project API so production web apps and embedded UIs tighten cross-origin access. Changes sync to Kong and the Studio proxy."
        features={[
          "Persisted in project config — survives schema pushes",
          "Wildcard or explicit HTTPS origins — JWT / RLS still apply",
          "Native iOS/Android clients are not affected by CORS (browser-only policy)",
          "Dismissable reminder when origins are unrestricted",
        ]}
      />
    )
  }

  return (
    <div className="space-y-4">
      {showOpenBanner ? (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm text-foreground">
          <div className="font-medium text-amber-300 mb-2">Browsers may call your API from any web origin</div>
          <p className="text-muted-foreground text-[0.85rem] leading-relaxed mb-2">
            {permissiveUnset && !savedListHasStar
              ? "No explicit allow-list is saved yet — the platform uses a permissive default so front-end builds are not silently blocked."
              : "Your allow-list includes * — every website can initiate cross-origin browser requests to your project URLs."}
            {" "}Authentication (JWT/session) and Row Level Security still apply — this setting does not bypass them.
            {" "}Native apps (Kotlin, Swift, URLSession, OkHttp, etc.) are not gated by CORS.
          </p>
          <p className="text-muted-foreground text-[0.85rem] leading-relaxed mb-3">
            Add specific HTTPS origins below to restrict which sites can run browser-side JavaScript against your API host.
          </p>
          <Button size="xs" onClick={dismissBanner}>Dismiss</Button>
        </div>
      ) : null}

      <Card className="p-4">
        <h3>CORS allowed origins</h3>
        <p className="text-[0.8rem] text-muted-foreground mb-4">
          Only applies to browsers. Use * only when you fully understand exposure. Leave empty and save only if you intentionally want strict lock-down (explicit empty list — browser requests with Origin may fail).
        </p>

        {loadError ? <p className="text-red-400 text-xs mb-3">{loadError}</p> : null}
        {loading ? <p className="text-muted-foreground text-xs mb-3">Loading…</p> : null}

        <div className="flex gap-2 mb-4">
          <Input
            className="flex-1"
            value={newOrigin}
            onChange={(e) => { setNewOrigin(e.target.value); setError(null) }}
            placeholder="https://my-app.com"
            disabled={loading}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd() }}
          />
          <Button variant="primary" onClick={handleAdd} disabled={loading}>Add origin</Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={loading || saveState === "saving"}
          >
            {saveState === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
        {saveState === "saved" ? <p className="text-green-400 text-xs mb-3">Saved</p> : null}
        {error ? <p className="text-red-400 text-xs mb-3">{error}</p> : null}

        <div className="flex flex-col gap-2">
          {origins.map((o) => (
            <div key={o.id} className="flex items-center justify-between px-3 py-2 border border-border rounded-md">
              <div>
                <code className="text-sm text-primary">{o.origin}</code>
              </div>
              <Button size="xs" variant="destructive" onClick={() => handleRemove(o.id)}>Remove</Button>
            </div>
          ))}
          {origins.length === 0 ? (
            <EmptyState
              title="No explicit origins in this editor"
              description="Saving with an empty list stores an explicit lock-down policy. Omitting origins in config is permissive until you save a list."
            />
          ) : null}
        </div>
      </Card>
    </div>
  )
}

// ─── Auth Settings Tab ────────────────────────────────────────────────────────

function AuthSettings(): React.ReactElement {
  const [providers, setProviders] = useState<AuthProviderConfig[]>([])
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [editClientId, setEditClientId] = useState("")
  const [editSecret, setEditSecret] = useState("")
  const [editScopes, setEditScopes] = useState("")

  // Auth config
  const [emailConfirmation, setEmailConfirmation] = useState(false)
  const [autoConfirmDev, setAutoConfirmDev] = useState(false)
  const [jwtExpiry, setJwtExpiry] = useState(0)
  const [redirectUrls, setRedirectUrls] = useState("")

  const toggleProvider = (provider: string) => {
    setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, enabled: !p.enabled } : p))
  }

  const startEditProvider = (p: AuthProviderConfig) => {
    setEditingProvider(p.provider)
    setEditClientId(p.client_id)
    setEditSecret("")
    setEditScopes(p.scopes)
  }

  const saveProvider = () => {
    if (!editingProvider) return
    setProviders((prev) => prev.map((p) =>
      p.provider === editingProvider ? {
        ...p,
        client_id: editClientId,
        client_secret_set: editSecret.length > 0 || p.client_secret_set,
        scopes: editScopes,
      } : p
    ))
    setEditingProvider(null)
  }

  return (
    <div className="space-y-4">
      {/* Auth providers */}
      <Card className="p-4">
        <h3>Authentication Providers</h3>
        <div className="flex flex-col gap-3 mt-4">
          {providers.length === 0 ? (
            <EmptyState
              title="No authentication providers configured"
              description="Live provider management will be available in a future release."
            />
          ) : null}
          {providers.map((p) => (
            <div key={p.provider} className="border border-border rounded-md p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={p.enabled ? "green" : "red"}>{p.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="font-medium text-sm capitalize">{p.provider}</span>
                  {p.client_id ? (
                    <code className="text-xs text-zinc-600">{p.client_id.slice(0, 15)}...</code>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button size="xs" onClick={() => toggleProvider(p.provider)}>
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  {p.provider !== "email" ? (
                    <Button size="xs" onClick={() => startEditProvider(p)}>Configure</Button>
                  ) : null}
                </div>
              </div>

              {editingProvider === p.provider ? (
                <div className="mt-3 pt-3 border-t border-border grid grid-cols-1 gap-2 max-w-[500px]">
                  <div>
                    <label className="block text-[0.8rem] text-muted-foreground mb-1">Client ID</label>
                    <Input value={editClientId} onChange={(e) => setEditClientId(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-[0.8rem] text-muted-foreground mb-1">
                      Client Secret {p.client_secret_set ? "(already set, leave blank to keep)" : ""}
                    </label>
                    <Input type="password" value={editSecret} onChange={(e) => setEditSecret(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-[0.8rem] text-muted-foreground mb-1">Scopes</label>
                    <Input value={editScopes} onChange={(e) => setEditScopes(e.target.value)} placeholder="openid email profile" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={saveProvider}>Save</Button>
                    <Button onClick={() => setEditingProvider(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      {/* Auth configuration */}
      <Card className="p-4">
        <h3>Auth Configuration</h3>
        <div className="flex flex-col gap-4 max-w-[500px] mt-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={emailConfirmation} onChange={(e) => setEmailConfirmation(e.target.checked)} />
            Require email confirmation
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoConfirmDev} onChange={(e) => setAutoConfirmDev(e.target.checked)} />
            Auto-confirm in development mode
          </label>
          <div>
            <label className="block text-[0.8rem] text-muted-foreground mb-1">JWT Expiry (seconds)</label>
            <Input
              type="number"
              className="w-[200px]"
              value={jwtExpiry}
              onChange={(e) => setJwtExpiry(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-[0.8rem] text-muted-foreground mb-1">
              Redirect URLs (one per line)
            </label>
            <textarea
              className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[80px] resize-y"
              value={redirectUrls}
              onChange={(e) => setRedirectUrls(e.target.value)}
            />
            <p className="text-xs text-zinc-600 mt-1">
              Only these URLs are allowed as redirect targets after OAuth login.
            </p>
          </div>
          <Button variant="primary" className="self-start">Save Auth Settings</Button>
        </div>
      </Card>
    </div>
  )
}

// ─── Danger Zone Tab ──────────────────────────────────────────────────────────

function DangerZone(): React.ReactElement {
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [resetConfirmText, setResetConfirmText] = useState("")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")

  return (
    <div className="rounded-lg border border-destructive bg-card p-4">
      <h3 className="text-red-400">Danger Zone</h3>
      <p className="text-[0.8rem] text-muted-foreground mb-6">
        These actions are irreversible. Proceed with extreme caution.
      </p>

      <div className="flex flex-col gap-5">
        {/* Reset Database */}
        <div className="flex justify-between items-center p-4 border border-border rounded-md">
          <div>
            <div className="font-medium mb-1">Reset Database</div>
            <div className="text-xs text-muted-foreground">
              Drop all tables and re-apply all migrations from scratch.
              All data will be permanently lost.
            </div>
          </div>
          {!confirmReset ? (
            <Button variant="destructive" onClick={() => setConfirmReset(true)}>Reset</Button>
          ) : (
            <div className="flex flex-col gap-2 items-end ml-4">
              <div>
                <label className="block text-[0.7rem] text-red-400 mb-1">Type "RESET" to confirm:</label>
                <Input
                  className="w-[200px]"
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                  placeholder="RESET"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={resetConfirmText !== "RESET"}
                >
                  Confirm Reset
                </Button>
                <Button onClick={() => { setConfirmReset(false); setResetConfirmText("") }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>

        {/* Delete Project */}
        <div className="flex justify-between items-center p-4 border border-border rounded-md">
          <div>
            <div className="font-medium mb-1">Delete Project</div>
            <div className="text-xs text-muted-foreground">
              Permanently delete this project, its database, storage files, and all associated data.
              This cannot be undone.
            </div>
          </div>
          {!confirmDelete ? (
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>Delete</Button>
          ) : (
            <div className="flex flex-col gap-2 items-end ml-4">
              <div>
                <label className="block text-[0.7rem] text-red-400 mb-1">Type "DELETE my-project" to confirm:</label>
                <Input
                  className="w-[250px]"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="DELETE my-project"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={deleteConfirmText !== "DELETE my-project"}
                >
                  Confirm Delete
                </Button>
                <Button onClick={() => { setConfirmDelete(false); setDeleteConfirmText("") }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Database Settings Tab ────────────────────────────────────────────────────

function DatabaseSettings({ client }: { client: ReturnType<typeof useStudioClient> }): React.ReactElement {
  const proxy = useProjectProxy()
  const { data: maxConns } = useApiQuery(() => proxy.sql("SHOW max_connections").then((r) => r.rows[0]?.["max_connections"] as string ?? "—"), [proxy])
  const { data: stmtTimeout } = useApiQuery(() => proxy.sql("SHOW statement_timeout").then((r) => r.rows[0]?.["statement_timeout"] as string ?? "—"), [proxy])
  const [credStatus, setCredStatus] = useState<{ mode: string; password_status: string; can_reveal: boolean; generation: number; message?: string } | null>(null)
  const [credLoading, setCredLoading] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null)
  const [credActionLoading, setCredActionLoading] = useState(false)

  const dbUrl = client.url.replace(/\/rest\/v1\/?$/, "")
  const connStr = dbUrl ? `postgres://postgres:[password]@${new URL(dbUrl).host}/postgres` : "—"
  const poolStr = dbUrl ? `postgres://postgres:[password]@${new URL(dbUrl).host}:5432/postgres?pgbouncer=true` : "—"

  const authHeaders = studioAuthHeaders(client)

  const loadCredentialStatus = useCallback(async () => {
    setCredLoading(true)
    setCredError(null)
    try {
      const res = await fetch(`${client.url}/admin/v1/database/credentials/status`, {
        headers: authHeaders,
        credentials: "include",
      })
      if (!res.ok) throw new Error(`status request failed (${res.status})`)
      const data = await res.json() as { mode: string; password_status: string; can_reveal: boolean; generation: number; message?: string }
      setCredStatus(data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load credential status"
      setCredError(msg)
    } finally {
      setCredLoading(false)
    }
  }, [client])

  useEffect(() => {
    void loadCredentialStatus()
  }, [loadCredentialStatus])

  const handleFirstView = useCallback(async () => {
    setCredActionLoading(true)
    setCredError(null)
    try {
      const res = await fetch(`${client.url}/admin/v1/database/credentials/first-view`, {
        method: "POST",
        headers: authHeaders,
        credentials: "include",
      })
      const data = await res.json() as { password?: string; error?: string }
      if (!res.ok || !data.password) throw new Error(data.error ?? `first-view failed (${res.status})`)
      setRevealedPassword(data.password)
      await loadCredentialStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reveal password"
      setCredError(msg)
    } finally {
      setCredActionLoading(false)
    }
  }, [client, loadCredentialStatus])

  const handleRotate = useCallback(async () => {
    setCredActionLoading(true)
    setCredError(null)
    setRevealedPassword(null)
    try {
      const res = await fetch(`${client.url}/admin/v1/database/credentials/rotate`, {
        method: "POST",
        headers: authHeaders,
        credentials: "include",
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `rotate failed (${res.status})`)
      await loadCredentialStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to rotate password"
      setCredError(msg)
    } finally {
      setCredActionLoading(false)
    }
  }, [client, loadCredentialStatus])

  return (
    <Card className="p-4 space-y-4 max-w-[600px]">
      <h3>Database</h3>
      <div className="space-y-3">
        {[
          { label: "Connection String", value: connStr },
          { label: "Pooler Connection String (PgBouncer)", value: poolStr },
          { label: "Max Connections", value: maxConns ?? "…" },
          { label: "Statement Timeout", value: stmtTimeout ?? "…" },
        ].map(({ label, value }) => (
          <div key={label}>
            <label className="block text-[0.8rem] text-muted-foreground mb-1">{label}</label>
            <Input className="text-muted-foreground font-mono text-xs" value={value} readOnly />
          </div>
        ))}
      </div>
      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">Credentials</p>
          <Button size="xs" onClick={() => void loadCredentialStatus()} disabled={credLoading || credActionLoading}>
            Refresh
          </Button>
        </div>
        {credLoading ? (
          <p className="text-xs text-muted-foreground">Loading credential status...</p>
        ) : credStatus ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Mode: <span className="text-foreground">{credStatus.mode}</span></p>
            <p>Status: <span className="text-foreground">{credStatus.password_status}</span></p>
            <p>Generation: <span className="text-foreground">{credStatus.generation}</span></p>
            {credStatus.message ? <p>{credStatus.message}</p> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No credential status available.</p>
        )}
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="primary"
            onClick={() => void handleFirstView()}
            disabled={credActionLoading || !credStatus?.can_reveal}
          >
            View Password
          </Button>
          <Button size="xs" onClick={() => void handleRotate()} disabled={credActionLoading}>
            Rotate Password
          </Button>
        </div>
        {revealedPassword ? (
          <CodeBlock className="text-xs">{revealedPassword}</CodeBlock>
        ) : null}
        {credError ? <p className="text-xs text-red-400">{credError}</p> : null}
      </div>
    </Card>
  )
}

// ─── Integrations Tab ─────────────────────────────────────────────────────────

function IntegrationsSettings(): React.ReactElement {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
      {[
        { name: "GitHub", desc: "Connect GitHub to enable CI/CD deployments and preview environments.", phase: "Phase 25" },
        { name: "Vercel", desc: "Sync preview deployments with Vercel for automatic branch previews.", phase: "Phase 25" },
      ].map(({ name, desc, phase }) => (
        <Card key={name} className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">{name}</h3>
            <Badge variant="yellow">{phase}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{desc}</p>
          <Button disabled>Coming Soon</Button>
        </Card>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface SettingsProps {
  demoMode?: boolean | undefined
}

export function Settings({ demoMode = false }: SettingsProps): React.ReactElement {
  const client = useStudioClient()
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")

  const tabs: Array<{ key: SettingsTab; label: string }> = [
    { key: "general", label: "General" },
    { key: "keys", label: "API Keys" },
    { key: "env", label: "Environment" },
    { key: "cors", label: "CORS" },
    { key: "database", label: "Database" },
    { key: "integrations", label: "Integrations" },
    { key: "danger", label: "Danger Zone" },
  ]

  return (
    <>
      <div className="flex border-b border-border mb-4 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={cn(
              "px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap",
              activeTab === tab.key
                ? tab.key === "danger" ? "text-red-400 border-red-400" : "text-primary border-primary"
                : "text-muted-foreground border-transparent hover:text-foreground"
            )}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" ? <GeneralSettings /> : null}
      {activeTab === "keys" ? <ApiKeysSettings /> : null}
      {activeTab === "env" ? <EnvSettings /> : null}
      {activeTab === "cors" ? <CorsSettings demoMode={demoMode} /> : null}
      {activeTab === "database" ? <DatabaseSettings client={client} /> : null}
      {activeTab === "integrations" ? <IntegrationsSettings /> : null}
      {activeTab === "danger" ? <DangerZone /> : null}
    </>
  )
}
