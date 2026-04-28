import React, { useState } from "react"
import { Badge, Button, Card, Input } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"

interface ProviderConfig {
  provider: string
  enabled: boolean
  clientId: string
  clientSecretSet: boolean
  scopes: string
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { provider: "email", enabled: true, clientId: "", clientSecretSet: false, scopes: "" },
  { provider: "github", enabled: false, clientId: "", clientSecretSet: false, scopes: "user:email" },
  { provider: "google", enabled: false, clientId: "", clientSecretSet: false, scopes: "openid email profile" },
  { provider: "gitlab", enabled: false, clientId: "", clientSecretSet: false, scopes: "read_user" },
  { provider: "bitbucket", enabled: false, clientId: "", clientSecretSet: false, scopes: "account" },
  { provider: "azure", enabled: false, clientId: "", clientSecretSet: false, scopes: "openid email profile" },
  { provider: "discord", enabled: false, clientId: "", clientSecretSet: false, scopes: "identify email" },
  { provider: "facebook", enabled: false, clientId: "", clientSecretSet: false, scopes: "email" },
  { provider: "slack", enabled: false, clientId: "", clientSecretSet: false, scopes: "openid email profile" },
  { provider: "spotify", enabled: false, clientId: "", clientSecretSet: false, scopes: "user-read-email" },
  { provider: "twitter", enabled: false, clientId: "", clientSecretSet: false, scopes: "" },
  { provider: "apple", enabled: false, clientId: "", clientSecretSet: false, scopes: "name email" },
  { provider: "linkedin", enabled: false, clientId: "", clientSecretSet: false, scopes: "openid profile email" },
  { provider: "keycloak", enabled: false, clientId: "", clientSecretSet: false, scopes: "openid" },
]

export function ProvidersView(): React.ReactElement {
  const [providers, setProviders] = useState<ProviderConfig[]>(DEFAULT_PROVIDERS)
  const [editing, setEditing] = useState<string | null>(null)
  const [editClientId, setEditClientId] = useState("")
  const [editSecret, setEditSecret] = useState("")
  const [editScopes, setEditScopes] = useState("")

  function toggle(provider: string) {
    setProviders((prev) => prev.map((p) => p.provider === provider ? { ...p, enabled: !p.enabled } : p))
  }

  function startEdit(p: ProviderConfig) {
    setEditing(p.provider)
    setEditClientId(p.clientId)
    setEditSecret("")
    setEditScopes(p.scopes)
  }

  function saveEdit() {
    if (!editing) return
    setProviders((prev) => prev.map((p) => p.provider === editing ? {
      ...p,
      clientId: editClientId,
      clientSecretSet: editSecret.length > 0 || p.clientSecretSet,
      scopes: editScopes,
    } : p))
    setEditing(null)
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Providers</h1>

      <Card className="p-4">
        <div className="space-y-3">
          {providers.length === 0 ? (
            <EmptyState title="No providers" description="Configure OAuth providers for your project." />
          ) : null}
          {providers.map((p) => (
            <div key={p.provider} className="border border-border rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Badge variant={p.enabled ? "green" : "red"}>{p.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="font-medium text-sm capitalize text-foreground">{p.provider}</span>
                  {p.clientId && <code className="text-xs text-muted-foreground">{p.clientId.slice(0, 15)}…</code>}
                </div>
                <div className="flex gap-2">
                  <Button size="xs" onClick={() => toggle(p.provider)}>{p.enabled ? "Disable" : "Enable"}</Button>
                  {p.provider !== "email" && <Button size="xs" onClick={() => startEdit(p)}>Configure</Button>}
                </div>
              </div>

              {editing === p.provider && (
                <div className="pt-3 border-t border-border grid gap-3 max-w-[480px]">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Client ID</label>
                    <Input value={editClientId} onChange={(e) => setEditClientId(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Client Secret {p.clientSecretSet ? "(already set — leave blank to keep)" : ""}
                    </label>
                    <Input type="password" value={editSecret} onChange={(e) => setEditSecret(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Scopes</label>
                    <Input value={editScopes} onChange={(e) => setEditScopes(e.target.value)} placeholder="openid email profile" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={saveEdit}>Save</Button>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
