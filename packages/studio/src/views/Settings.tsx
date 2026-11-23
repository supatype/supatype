import React, { useState, useCallback, useEffect } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { bodyErrorText, type Guard, isBoolean, isJsonObject, isNumber, isShape, isString, optional, readJson, readJsonObject } from "../lib/json.js"
import { Badge, Button, Card, Checkbox, CodeBlock, ConfirmButton, Input, Select, Tabs, Textarea, type DestructiveQuestion, type TabsSpec } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ConnectionStringPanel } from "../components/database/ConnectionStringPanel.js"
import { ApiCorsSettings } from "./ApiCorsSettings.js"
import { FunctionSecrets } from "./FunctionSecrets.js"
import { RoleGate, useRoleRefusalText, type RoleRequirement } from "../components/RoleGate.js"
import { proxyFailure, unlessRoleRefused } from "../lib/role-refusal.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string
  name: string
  role: "anon" | "service_role"
  key: string
  created_at: string
  last_used: string | null
}

interface AuthProviderConfig {
  provider: string
  enabled: boolean
  client_id: string
  client_secret_set: boolean
  scopes: string
}

type SettingsTab = "general" | "keys" | "env" | "cors" | "database" | "integrations"

// ─── General Settings Tab ─────────────────────────────────────────────────────

function GeneralSettings(): React.ReactElement {
  const client = useStudioClient()
  const adminConfig = useAdminConfig()
  const [projectName, setProjectName] = useState(adminConfig.branding?.appName ?? "")
  const [siteUrl, setSiteUrl] = useState("")
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

/** The anon key from the cloud host's runtime config, when a cloud host is serving Studio. */
function runtimeAnonKey(): string | undefined {
  if (typeof window === "undefined" || !("__SUPATYPE_CLOUD__" in window)) return undefined
  const cloud = window.__SUPATYPE_CLOUD__
  const key = isJsonObject(cloud) ? cloud["anonKey"] : undefined
  return typeof key === "string" ? key : undefined
}

function ApiKeysSettings(): React.ReactElement {
  const [showKeys, setShowKeys] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  // Only the anon key. It is publishable by design, safe in a browser bundle and
  // safe to show. The service role key is deliberately absent: anything that puts
  // it in the browser makes it readable by anyone who opens devtools, so it is
  // never shipped to Studio and therefore never displayable here.
  const anonKey =
    runtimeAnonKey() ??
    (typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: Record<string, string> }).env?.["VITE_SUPATYPE_ANON_KEY"]
      : undefined) ??
    ""

  const keys: ApiKey[] = anonKey
    ? [
        {
          id: "anon",
          name: "anon",
          role: "anon" as const,
          key: anonKey,
          created_at: new Date(0).toISOString(),
          last_used: null,
        },
      ]
    : []

  const copyToClipboard = (text: string, keyId: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(keyId)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="m-0">API Keys</h3>
        <Button size="sm" onClick={() => setShowKeys(!showKeys)}>
          {showKeys ? "Hide Keys" : "Show Keys"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Only the publishable anon key is shown here. The service role key bypasses Row
        Level Security, so it is never sent to the browser, read it with{" "}
        <code>supatype keys</code>, or from Cloud → Project Settings.
      </p>
      <div className="flex flex-col gap-4">
        {keys.length === 0 ? (
          <EmptyState
            title="No anon key in Studio runtime"
            description="Set VITE_SUPATYPE_ANON_KEY in Studio config, or open Cloud project settings."
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

// ─── CORS Origins Tab ─────────────────────────────────────────────────────────

/**
 * The CORS tab is the allowed-origins page: what the project's gateway enforces, read and changed
 * through `/admin/cors-origins` on self-host and the control plane's project route on Cloud, so
 * both hosts show one setting from one source. The demo build has no gateway to ask, so it only
 * says where the list comes from.
 */
function CorsSettings({ demoMode }: { demoMode: boolean }): React.ReactElement {
  if (!demoMode) return <ApiCorsSettings />
  return (
    <Card className="p-4">
      <h3>CORS allowed origins</h3>
      <p className="mt-2 max-w-[640px] text-[0.85rem] text-muted-foreground leading-relaxed">
        A deployed project allows browsers from its site URL and from the origins in{" "}
        <code>api.corsOrigins</code> or <code>SUPATYPE_CORS_ALLOW_ORIGINS</code> in <code>.env</code>.
        Owners, admins and developers can change the list here; <code>supatype dev</code> allows every origin.
      </p>
    </Card>
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
          <Checkbox className="gap-2 text-sm text-foreground" label="Require email confirmation" checked={emailConfirmation} onChange={(e) => setEmailConfirmation(e.target.checked)} />
          <Checkbox className="gap-2 text-sm text-foreground" label="Auto-confirm in development mode" checked={autoConfirmDev} onChange={(e) => setAutoConfirmDev(e.target.checked)} />
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
            <Textarea
              aria-label="Redirect URLs (one per line)"
              className="py-1.5 min-h-[80px] resize-y"
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

// ─── Database Settings Tab ────────────────────────────────────────────────────

/** A server setting as shown, or a dash when the server did not report it. */
function settingText(value: unknown): string {
  return typeof value === "string" ? value : "-"
}

/** GET /admin/v1/database/credentials/status. */
interface CredentialStatus {
  mode: string
  password_status: string
  can_reveal: boolean
  generation: number
  message?: string
}

const isCredentialStatus: Guard<CredentialStatus> = isShape({
  mode: isString,
  password_status: isString,
  can_reveal: isBoolean,
  generation: isNumber,
  message: optional(isString),
})

/** A rotation replaces the password at once, so everything still using the old one is refused. */
const ROTATE_QUESTION: DestructiveQuestion = {
  title: "Rotate the database password?",
  detail: <p>A new password replaces the current one at once. Any app or tool still connecting with the old password is refused until it is given the new one.</p>,
  answer: "Rotate password",
}

type StudioClient = ReturnType<typeof useStudioClient>

/** One call to the credentials API, as Studio's session; a 403 is the proxy refusing the role. */
async function credentialsFetch(client: StudioClient, path: string, refused: string, method = "GET"): Promise<Response> {
  const res = await fetch(`${client.url}/admin/v1/database/credentials/${path}`, {
    method,
    headers: studioAuthHeaders(client),
    credentials: "include",
  })
  return unlessRoleRefused(res, refused)
}

/** Reveals the password the first time it is asked for; the server refuses it after that. */
async function firstViewPassword(client: StudioClient, refused: string): Promise<string> {
  const res = await credentialsFetch(client, "first-view", refused, "POST")
  const data = await readJsonObject(res)
  const password = data["password"]
  if (!res.ok || typeof password !== "string" || !password) throw new Error(bodyErrorText(data) ?? `first-view failed (${res.status})`)
  return password
}

async function rotatePassword(client: StudioClient, refused: string): Promise<void> {
  const res = await credentialsFetch(client, "rotate", refused, "POST")
  if (!res.ok) throw new Error(bodyErrorText(await readJsonObject(res)) ?? `rotate failed (${res.status})`)
}

interface Credentials {
  status: CredentialStatus | null
  loading: boolean
  busy: boolean
  error: string | null
  reload: () => Promise<void>
  /** Runs one credential action, then reads the status again; a failure is shown, not thrown. */
  run: (action: () => Promise<void>, fallback: string) => Promise<void>
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error ? err.message : fallback)

async function credentialStatus(client: StudioClient, refused: string): Promise<CredentialStatus> {
  const res = await credentialsFetch(client, "status", refused)
  if (!res.ok) throw await proxyFailure(res, refused)
  return readJson(res, isCredentialStatus)
}

/** Where one piece of work reports that it is running, and what went wrong. */
interface Attempt {
  setPending: (pending: boolean) => void
  setError: (error: string | null) => void
}

/** Runs `work`, pending while it does; a failure is shown through `setError`, not thrown. */
async function attempt({ setPending, setError }: Attempt, work: () => Promise<void>, fallback: string): Promise<void> {
  setPending(true)
  setError(null)
  try {
    await work()
  } catch (err) {
    setError(errorText(err, fallback))
  } finally {
    setPending(false)
  }
}

function useCredentials(client: StudioClient, refused: string): Credentials {
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(
    () => attempt({ setPending: setLoading, setError }, async () => setStatus(await credentialStatus(client, refused)), "Failed to load credential status"),
    [client, refused],
  )
  useEffect(() => { void reload() }, [reload])

  const run = useCallback(
    (action: () => Promise<void>, fallback: string) => attempt({ setPending: setBusy, setError }, async () => { await action(); await reload() }, fallback),
    [reload],
  )
  return { status, loading, busy, error, reload, run }
}

function CredentialStatusLines({ creds }: { creds: Credentials }): React.ReactElement {
  if (creds.loading) return <p className="text-xs text-muted-foreground">Loading credential status...</p>
  if (!creds.status) return <p className="text-xs text-muted-foreground">No credential status available.</p>
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>Mode: <span className="text-foreground">{creds.status.mode}</span></p>
      <p>Status: <span className="text-foreground">{creds.status.password_status}</span></p>
      <p>Generation: <span className="text-foreground">{creds.status.generation}</span></p>
      {creds.status.message ? <p>{creds.status.message}</p> : null}
    </div>
  )
}

interface DatabaseCredentialsProps {
  client: StudioClient
  /** The password once revealed, for the connection strings above; null again after a rotation. */
  onPassword: (password: string | null) => void
}

/** The database password's status, its one-time reveal and its rotation: project administration. */
function DatabaseCredentials({ client, onPassword }: DatabaseCredentialsProps): React.ReactElement {
  const refused = useRoleRefusalText()
  const creds = useCredentials(client, refused)
  const [revealed, setRevealed] = useState<string | null>(null)
  const show = (password: string | null) => { setRevealed(password); onPassword(password) }
  const reveal = () => creds.run(async () => show(await firstViewPassword(client, refused)), "Failed to reveal password")
  const rotate = () => creds.run(async () => { show(null); await rotatePassword(client, refused) }, "Failed to rotate password")
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Credentials</p>
        <Button size="xs" onClick={() => void creds.reload()} disabled={creds.loading || creds.busy}>Refresh</Button>
      </div>
      <CredentialStatusLines creds={creds} />
      <div className="flex gap-2">
        <Button size="xs" variant="primary" onClick={() => void reveal()} disabled={creds.busy || !creds.status?.can_reveal}>
          View Password
        </Button>
        <ConfirmButton size="xs" ask={ROTATE_QUESTION} act={() => void rotate()} disabled={creds.busy}>
          Rotate Password
        </ConfirmButton>
      </div>
      {revealed ? <CodeBlock className="text-xs">{revealed}</CodeBlock> : null}
      {creds.error ? <p className="text-xs text-red-400">{creds.error}</p> : null}
    </div>
  )
}

function DatabaseSettings({ client }: { client: StudioClient }): React.ReactElement {
  const proxy = useProjectProxy()
  // Through the metadata catalogue (RQ3b), so a viewer sees the settings too.
  const { data: dbSettings } = useApiQuery(() => proxy.metadata("database_settings").then((r) => r.rows[0] ?? {}), [proxy])
  const maxConns = dbSettings === null ? null : settingText(dbSettings["max_connections"])
  const stmtTimeout = dbSettings === null ? null : settingText(dbSettings["statement_timeout"])
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null)

  return (
    <Card className="p-4 space-y-4 max-w-[600px]">
      <h3>Database</h3>
      <ConnectionStringPanel password={revealedPassword} />
      <div className="space-y-3">
        {[
          { label: "Max Connections", value: maxConns ?? "…" },
          { label: "Statement Timeout", value: stmtTimeout ?? "…" },
        ].map(({ label, value }) => (
          <div key={label}>
            <label className="block text-[0.8rem] text-muted-foreground mb-1">{label}</label>
            <Input className="text-muted-foreground font-mono text-xs" value={value} readOnly />
          </div>
        ))}
      </div>
      <RoleGate needs="administer" activity="manage the database credentials">
        <DatabaseCredentials client={client} onPassword={setRevealedPassword} />
      </RoleGate>
    </Card>
  )
}

// ─── Integrations Tab ─────────────────────────────────────────────────────────

function IntegrationsSettings(): React.ReactElement {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
      {[
        { name: "GitHub", desc: "Connect GitHub to enable CI/CD deployments and preview environments." },
        { name: "Vercel", desc: "Sync preview deployments with Vercel for automatic branch previews." },
      ].map(({ name, desc }) => (
        <Card key={name} className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">{name}</h3>
            <Badge variant="yellow">Coming soon</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{desc}</p>
          <Button disabled>Connect</Button>
        </Card>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface SettingsProps {
  demoMode?: boolean | undefined
}

interface SettingsTabDef extends RoleRequirement {
  key: SettingsTab
  label: string
}

/** Every tab, with what it needs from the shared role matrix; a role without it is told why. */
const SETTINGS_TABS: SettingsTabDef[] = [
  { key: "general", label: "General", needs: "administer", activity: "change the project settings" },
  { key: "keys", label: "API Keys", needs: "manageKeys", activity: "see the project's API keys" },
  { key: "env", label: "Environment", needs: "administer", activity: "manage function secrets" },
  { key: "cors", label: "CORS", needs: "manageDomains", activity: "manage allowed origins" },
  { key: "database", label: "Database", needs: "schemaView", activity: "view the database settings" },
  { key: "integrations", label: "Integrations", needs: "administer", activity: "manage integrations" },
]

/** The tab bar over the sections. */
const SETTINGS_TAB_BAR: TabsSpec<SettingsTab> = {
  label: "Settings sections",
  items: SETTINGS_TABS.map((t) => ({ id: t.key, label: t.label })),
}

function SettingsTabBody({ tab, demoMode }: { tab: SettingsTab; demoMode: boolean }): React.ReactElement {
  const client = useStudioClient()
  switch (tab) {
    case "general": return <GeneralSettings />
    case "keys": return <ApiKeysSettings />
    case "env": return <FunctionSecrets />
    case "cors": return <CorsSettings demoMode={demoMode} />
    case "database": return <DatabaseSettings client={client} />
    case "integrations": return <IntegrationsSettings />
  }
}

export function Settings({ demoMode = false }: SettingsProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")
  const tab = SETTINGS_TABS.find((t) => t.key === activeTab) ?? SETTINGS_TABS[0]!

  return (
    <>
      <div className="mb-4">
        <Tabs tabs={SETTINGS_TAB_BAR} value={activeTab} onChange={setActiveTab} />
      </div>
      <RoleGate needs={tab.needs} activity={tab.activity}>
        <SettingsTabBody tab={activeTab} demoMode={demoMode} />
      </RoleGate>
    </>
  )
}
