import React, { useState, useCallback } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

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

type SettingsTab = "general" | "keys" | "env" | "cors" | "auth" | "danger"

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockApiKeys: ApiKey[] = [
  {
    id: "k1",
    name: "anon (public)",
    role: "anon",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDAwfQ.anon-key",
    created_at: "2026-01-01T00:00:00Z",
    last_used: "2026-03-10T10:30:00Z",
  },
  {
    id: "k2",
    name: "service_role (secret)",
    role: "service_role",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.service-key",
    created_at: "2026-01-01T00:00:00Z",
    last_used: "2026-03-10T09:15:00Z",
  },
]

const mockEnvVars: EnvVar[] = [
  { key: "DATABASE_URL", value: "postgresql://postgres:postgres@localhost:5432/my-project", sensitive: true, source: "env" },
  { key: "JWT_SECRET", value: "super-secret-jwt-token-change-in-production", sensitive: true, source: "env" },
  { key: "SITE_URL", value: "http://localhost:3000", sensitive: false, source: "config" },
  { key: "GOTRUE_MAILER_AUTOCONFIRM", value: "true", sensitive: false, source: "config" },
  { key: "S3_ENDPOINT", value: "http://localhost:9000", sensitive: false, source: "env" },
  { key: "S3_ACCESS_KEY", value: "supatype", sensitive: true, source: "env" },
  { key: "S3_SECRET_KEY", value: "supatype-secret", sensitive: true, source: "env" },
  { key: "SMTP_HOST", value: "smtp.mailtrap.io", sensitive: false, source: "config" },
  { key: "SMTP_PORT", value: "587", sensitive: false, source: "config" },
  { key: "SMTP_USER", value: "mailtrap-user", sensitive: true, source: "config" },
  { key: "SMTP_PASS", value: "mailtrap-pass", sensitive: true, source: "config" },
]

const mockCorsOrigins: CorsOrigin[] = [
  { id: "c1", origin: "http://localhost:3000", created_at: "2026-01-01T00:00:00Z" },
  { id: "c2", origin: "http://localhost:5173", created_at: "2026-01-01T00:00:00Z" },
  { id: "c3", origin: "https://my-app.com", created_at: "2026-02-15T10:00:00Z" },
]

const mockAuthProviders: AuthProviderConfig[] = [
  { provider: "email", enabled: true, client_id: "", client_secret_set: false, scopes: "" },
  { provider: "github", enabled: true, client_id: "gh-client-id-xxx", client_secret_set: true, scopes: "user:email" },
  { provider: "google", enabled: false, client_id: "", client_secret_set: false, scopes: "openid email profile" },
  { provider: "apple", enabled: false, client_id: "", client_secret_set: false, scopes: "email name" },
]

// ─── General Settings Tab ─────────────────────────────────────────────────────

function GeneralSettings(): React.ReactElement {
  const [projectName, setProjectName] = useState("my-project")
  const [siteUrl, setSiteUrl] = useState("http://localhost:3000")
  const [dbUrl] = useState("postgresql://postgres:postgres@localhost:5432/my-project")
  const [apiUrl] = useState("http://localhost:54321")
  const [region] = useState("us-east-1")
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
  const [keys, setKeys] = useState<ApiKey[]>(mockApiKeys)
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
        {keys.map((k) => (
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
  const [envVars, setEnvVars] = useState<EnvVar[]>(mockEnvVars)
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
    </Card>
  )
}

// ─── CORS Origins Tab ─────────────────────────────────────────────────────────

function CorsSettings(): React.ReactElement {
  const [origins, setOrigins] = useState<CorsOrigin[]>(mockCorsOrigins)
  const [newOrigin, setNewOrigin] = useState("")
  const [error, setError] = useState<string | null>(null)

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

  return (
    <Card className="p-4">
      <h3>CORS Allowed Origins</h3>
      <p className="text-[0.8rem] text-muted-foreground mb-4">
        Configure which origins can make requests to your API. Use * for development only.
      </p>

      <div className="flex gap-2 mb-4">
        <Input
          className="flex-1"
          value={newOrigin}
          onChange={(e) => { setNewOrigin(e.target.value); setError(null) }}
          placeholder="https://my-app.com"
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd() }}
        />
        <Button variant="primary" onClick={handleAdd}>Add Origin</Button>
      </div>
      {error ? <p className="text-red-400 text-xs mb-3">{error}</p> : null}

      <div className="flex flex-col gap-2">
        {origins.map((o) => (
          <div key={o.id} className="flex items-center justify-between px-3 py-2 border border-border rounded-md">
            <div>
              <code className="text-sm text-primary">{o.origin}</code>
              <span className="text-xs text-zinc-600 ml-2">added {new Date(o.created_at).toLocaleDateString()}</span>
            </div>
            <Button size="xs" variant="destructive" onClick={() => handleRemove(o.id)}>Remove</Button>
          </div>
        ))}
        {origins.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No CORS origins configured. API requests from browsers will be blocked.</p>
        ) : null}
      </div>
    </Card>
  )
}

// ─── Auth Settings Tab ────────────────────────────────────────────────────────

function AuthSettings(): React.ReactElement {
  const [providers, setProviders] = useState<AuthProviderConfig[]>(mockAuthProviders)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [editClientId, setEditClientId] = useState("")
  const [editSecret, setEditSecret] = useState("")
  const [editScopes, setEditScopes] = useState("")

  // Auth config
  const [emailConfirmation, setEmailConfirmation] = useState(true)
  const [autoConfirmDev, setAutoConfirmDev] = useState(true)
  const [jwtExpiry, setJwtExpiry] = useState(3600)
  const [redirectUrls, setRedirectUrls] = useState("http://localhost:3000/auth/callback\nhttps://my-app.com/auth/callback")

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

// ─── Main Component ───────────────────────────────────────────────────────────

export function Settings(): React.ReactElement {
  const client = useStudioClient()
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")

  const tabs: Array<{ key: SettingsTab; label: string }> = [
    { key: "general", label: "General" },
    { key: "keys", label: "API Keys" },
    { key: "env", label: "Environment" },
    { key: "cors", label: "CORS" },
    { key: "auth", label: "Auth Settings" },
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
      {activeTab === "cors" ? <CorsSettings /> : null}
      {activeTab === "auth" ? <AuthSettings /> : null}
      {activeTab === "danger" ? <DangerZone /> : null}
    </>
  )
}
