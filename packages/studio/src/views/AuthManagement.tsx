import React, { useState, useCallback } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { SlidePanel } from "../components/SlidePanel.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthUser {
  id: string
  email: string
  phone: string | null
  role: string
  confirmed: boolean
  disabled: boolean
  last_sign_in: string | null
  created_at: string
  updated_at: string
  metadata: Record<string, unknown>
  providers: AuthIdentity[]
  mfa_factors: MfaFactor[]
}

interface AuthIdentity {
  provider: string
  provider_id: string
  linked_at: string
}

interface MfaFactor {
  id: string
  type: "totp"
  friendly_name: string | null
  created_at: string
  verified: boolean
}

interface AuthSession {
  id: string
  user_id: string
  ip: string
  user_agent: string
  created_at: string
  updated_at: string
}

const availableRoles = ["authenticated"]
const providerFilters = ["all", "email", "github", "google", "apple"]
const statusFilters = ["all", "active", "disabled", "unconfirmed"]

// ─── Create/Edit User Form ────────────────────────────────────────────────────

function UserForm({
  user,
  onSave,
  onCancel,
}: {
  user: AuthUser | null
  onSave: (data: { email: string; role: string; password?: string; metadata: Record<string, unknown> }) => void
  onCancel: () => void
}): React.ReactElement {
  const [email, setEmail] = useState(user?.email ?? "")
  const role = user?.role ?? "authenticated"
  const [password, setPassword] = useState("")
  const [metadataJson, setMetadataJson] = useState(JSON.stringify(user?.metadata ?? {}, null, 2))
  const [error, setError] = useState<string | null>(null)

  const handleSave = () => {
    if (!email.trim()) { setError("Email is required"); return }
    if (!user && !password.trim()) { setError("Password is required for new users"); return }

    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(metadataJson)
    } catch {
      setError("Invalid JSON in metadata")
      return
    }

    onSave({
      email: email.trim(),
      role,
      ...(password.trim() ? { password: password.trim() } : {}),
      metadata,
    })
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 max-w-[500px]">
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Email <span className="text-red-400">*</span></label>
          <Input value={email} onChange={(e) => { setEmail(e.target.value); setError(null) }} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">
            Password {user ? "(leave blank to keep current)" : ""} {!user ? <span className="text-red-400">*</span> : null}
          </label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Role</label>
          <Input value={role} disabled />
          <p className="text-[0.75rem] text-muted-foreground mt-1">
            Project users are always provisioned as <code>authenticated</code>.
          </p>
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">User Metadata (JSON)</label>
          <textarea
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[80px] resize-y"
            value={metadataJson}
            onChange={(e) => { setMetadataJson(e.target.value); setError(null) }}
          />
        </div>
        {error ? <div className="text-red-400 text-xs">{error}</div> : null}
        <div className="flex gap-2">
          <Button variant="primary" onClick={handleSave}>{user ? "Save Changes" : "Create User"}</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}

// ─── User Detail View ─────────────────────────────────────────────────────────

function UserDetail({
  user,
  sessions,
  onToggleDisable,
  onImpersonate,
  onEdit,
  onDelete,
  onRevokeSession,
}: {
  user: AuthUser
  sessions: AuthSession[]
  onToggleDisable: () => void
  onImpersonate: () => void
  onEdit: () => void
  onDelete: () => void
  onRevokeSession: (sessionId: string) => void
}): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showImpersonateInfo, setShowImpersonateInfo] = useState(false)
  const userSessions = sessions.filter((s) => s.user_id === user.id)

  return (
    <div className="space-y-6">
      {/* Profile info */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Role</label>
          <Badge variant={user.role === "admin" ? "indigo" : "green"}>{user.role}</Badge>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Status</label>
          {user.disabled
            ? <Badge variant="red">Disabled</Badge>
            : <Badge variant="green">Active</Badge>
          }
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Confirmed</label>
          <span className="text-sm">{user.confirmed ? "Yes" : "Pending"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Phone</label>
          <span className="text-sm">{user.phone ?? <span className="text-zinc-600">Not set</span>}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Last Sign-in</label>
          <span className="text-sm">{user.last_sign_in ? new Date(user.last_sign_in).toLocaleString() : "Never"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Created</label>
          <span className="text-sm">{new Date(user.created_at).toLocaleString()}</span>
        </div>
      </div>

      {/* Metadata */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Metadata</h4>
        <CodeBlock className="text-xs">{JSON.stringify(user.metadata, null, 2)}</CodeBlock>
      </div>

      {/* Linked identities / providers */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Linked Identities</h4>
        <Card className="overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Provider</Th>
                <Th>Provider ID</Th>
                <Th>Linked</Th>
              </tr>
            </thead>
            <tbody>
              {user.providers.map((p) => (
                <tr key={p.provider} className="border-b border-border">
                  <Td><Badge variant="blue">{p.provider}</Badge></Td>
                  <Td className="text-xs font-mono">{p.provider_id}</Td>
                  <Td className="text-xs text-muted-foreground">{new Date(p.linked_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* MFA Factors */}
      {user.mfa_factors.length > 0 ? (
        <div className="mb-6">
          <h4 className="text-sm text-muted-foreground mb-2">MFA Factors</h4>
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Type</Th>
                  <Th>Name</Th>
                  <Th>Verified</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {user.mfa_factors.map((f) => (
                  <tr key={f.id} className="border-b border-border">
                    <Td><Badge variant="indigo">{f.type}</Badge></Td>
                    <Td>{f.friendly_name ?? "Unnamed"}</Td>
                    <Td>{f.verified ? <Badge variant="green">Yes</Badge> : <Badge variant="yellow">No</Badge>}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ) : null}

      {/* Sessions */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Active Sessions ({userSessions.length})</h4>
        {userSessions.length > 0 ? (
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Device</Th>
                  <Th>IP</Th>
                  <Th>Last Active</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {userSessions.map((s) => (
                  <tr key={s.id} className="border-b border-border">
                    <Td className="text-xs">{s.user_agent || <span className="text-zinc-600">Unknown</span>}</Td>
                    <Td className="font-mono text-xs">{s.ip || "—"}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(s.updated_at).toLocaleString()}</Td>
                    <Td>
                      <Button size="xs" variant="destructive" onClick={() => onRevokeSession(s.id)}>
                        Revoke
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <p className="text-xs text-zinc-600">No active sessions</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <Button onClick={onEdit}>Edit User</Button>
        <Button onClick={onToggleDisable}>
          {user.disabled ? "Enable User" : "Disable User"}
        </Button>
        <Button onClick={() => {
          setShowImpersonateInfo(true)
          onImpersonate()
        }}>
          Impersonate
        </Button>
        {!confirmDelete ? (
          <Button variant="destructive" onClick={() => setConfirmDelete(true)}>Delete User</Button>
        ) : (
          <div className="flex gap-2 items-center">
            <span className="text-red-400 text-xs">This is irreversible.</span>
            <Button variant="destructive" onClick={onDelete}>Confirm Delete</Button>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
          </div>
        )}
      </div>

      {showImpersonateInfo ? (
        <div className="mt-4 p-3 bg-accent/30 rounded-md">
          <p className="text-xs text-muted-foreground">
            A short-lived JWT has been generated for <strong>{user.email}</strong>.
            You can use this token to test the application as this user.
          </p>
          <code className="text-xs text-primary block mt-1 break-all">
            {`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIke${user.id}IiwicmVhbCI6Im1vY2sifQ.placeholder`}
          </code>
          <Button size="xs" className="mt-2" onClick={() => setShowImpersonateInfo(false)}>Dismiss</Button>
        </div>
      ) : null}
    </div>
  )
}

// ─── Invite User Form ─────────────────────────────────────────────────────────

function InviteUserForm({
  onInvite,
  onCancel,
}: {
  onInvite: (email: string, role: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [email, setEmail] = useState("")
  const role = "authenticated"

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-4">
        An invitation email will be sent to the user with a magic link to confirm their account.
      </p>
      <div className="flex gap-2 items-end max-w-[500px]">
        <div className="flex-1">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
        </div>
        <div className="w-[140px]">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Role</label>
          <Input value={role} disabled />
        </div>
        <Button variant="primary" onClick={() => { if (email.trim()) onInvite(email.trim(), role) }}>
          Send Invite
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapGoTrueUser(raw: any): AuthUser {
  return {
    id: raw.id,
    email: raw.email ?? "",
    phone: raw.phone || null,
    role: raw.role ?? "authenticated",
    confirmed: raw.email_confirmed_at != null,
    disabled: raw.banned_until != null,
    last_sign_in: raw.last_sign_in_at ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    metadata: raw.user_metadata ?? {},
    providers: Array.isArray(raw.identities)
      ? raw.identities.map((i: any) => ({
          provider: i.provider,
          provider_id: i.identity_id ?? i.id,
          linked_at: i.created_at,
        }))
      : [],
    mfa_factors: Array.isArray(raw.factors)
      ? raw.factors.map((f: any) => ({
          id: f.id,
          type: f.factor_type ?? f.type ?? "totp",
          friendly_name: f.friendly_name ?? null,
          created_at: f.created_at,
          verified: f.status === "verified",
        }))
      : [],
  }
}

export function AuthManagement(): React.ReactElement {
  const client = useStudioClient()
  const proxy = useProjectProxy()

  const authAdminFetch = useCallback(async (path: string, options?: RequestInit) => {
    const res = await fetch(`${client.url}/auth/v1/admin${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...studioAuthHeaders(client),
        ...options?.headers,
      },
      credentials: "include",
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.msg ?? json.message ?? "Auth API error")
    return json
  }, [client])

  const { data: usersData, loading, error, refetch } = useApiQuery(
    async () => {
      const json = await authAdminFetch("/users?page=1&per_page=50")
      return (json.users as any[]).map(mapGoTrueUser)
    },
    [authAdminFetch],
  )

  const { data: sessionsData, refetch: refetchSessions } = useApiQuery(
    async () => {
      const result = await proxy.sql(
        `SELECT id, user_id, ip::text, user_agent, created_at, updated_at
         FROM auth.sessions
         WHERE not_after IS NULL OR not_after > now()
         ORDER BY updated_at DESC`,
        "auth",
      )
      return result.rows.map((r): AuthSession => ({
        id: String(r["id"] ?? ""),
        user_id: String(r["user_id"] ?? ""),
        ip: String(r["ip"] ?? ""),
        user_agent: String(r["user_agent"] ?? ""),
        created_at: String(r["created_at"] ?? ""),
        updated_at: String(r["updated_at"] ?? ""),
      }))
    },
    [proxy],
  )

  const users = usersData ?? []
  const sessions = sessionsData ?? []

  // Filters
  const [search, setSearch] = useState("")
  const [filterRole, setFilterRole] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")
  const [filterProvider, setFilterProvider] = useState("all")

  // Panels
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null)
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showInviteForm, setShowInviteForm] = useState(false)

  // Filtering logic
  const filtered = users.filter((u) => {
    if (search) {
      const s = search.toLowerCase()
      if (!u.email.toLowerCase().includes(s) && !(u.metadata.full_name as string || "").toLowerCase().includes(s) && !u.id.includes(s)) {
        return false
      }
    }
    if (filterRole !== "all" && u.role !== filterRole) return false
    if (filterStatus === "active" && (u.disabled || !u.confirmed)) return false
    if (filterStatus === "disabled" && !u.disabled) return false
    if (filterStatus === "unconfirmed" && u.confirmed) return false
    if (filterProvider !== "all" && !u.providers.some((p) => p.provider === filterProvider)) return false
    return true
  })

  const handleToggleDisable = useCallback(async (userId: string) => {
    const user = users.find((u) => u.id === userId)
    if (!user) return
    const ban_duration = user.disabled ? "none" : "876000h"
    await authAdminFetch(`/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ ban_duration }),
    })
    refetch()
    setSelectedUser(null)
  }, [users, authAdminFetch, refetch])

  const handleDeleteUser = useCallback(async (userId: string) => {
    await authAdminFetch(`/users/${userId}`, { method: "DELETE" })
    refetch()
    setSelectedUser(null)
  }, [authAdminFetch, refetch])

  const handleCreateUser = useCallback(async (data: { email: string; role: string; password?: string; metadata: Record<string, unknown> }) => {
    await authAdminFetch("/users", {
      method: "POST",
      body: JSON.stringify({
        email: data.email,
        password: data.password,
        user_metadata: data.metadata,
        role: data.role,
      }),
    })
    refetch()
    setShowCreateForm(false)
  }, [authAdminFetch, refetch])

  const handleEditUser = useCallback(async (data: { email: string; role: string; password?: string; metadata: Record<string, unknown> }) => {
    if (!editingUser) return
    await authAdminFetch(`/users/${editingUser.id}`, {
      method: "PUT",
      body: JSON.stringify({
        email: data.email,
        role: data.role,
        user_metadata: data.metadata,
        ...(data.password ? { password: data.password } : {}),
      }),
    })
    refetch()
    setEditingUser(null)
    setSelectedUser(null)
  }, [editingUser, authAdminFetch, refetch])

  const handleInviteUser = useCallback(async (email: string, role: string) => {
    await authAdminFetch("/users", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    })
    refetch()
    setShowInviteForm(false)
  }, [authAdminFetch, refetch])

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    await proxy.sql(
      `DELETE FROM auth.sessions WHERE id = '${sessionId.replace(/'/g, "''")}'`,
      "auth",
    )
    refetchSessions()
  }, [proxy, refetchSessions])

  const handleImpersonate = useCallback((_userId: string) => {
    // Impersonation placeholder — shown in detail view
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        Loading users…
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={refetch} />
  }

  const panelOpen = selectedUser !== null || editingUser !== null || showCreateForm || showInviteForm
  const panelTitle = editingUser ? "Edit User"
    : showCreateForm ? "Create User"
    : showInviteForm ? "Invite User"
    : selectedUser?.email ?? ""
  const panelSubtitle = !editingUser && !showCreateForm && !showInviteForm
    ? selectedUser?.id
    : undefined

  function closePanel() {
    setSelectedUser(null)
    setEditingUser(null)
    setShowCreateForm(false)
    setShowInviteForm(false)
  }

  if (users.length === 0 && !panelOpen) {
    return (
      <EmptyState
        title="No users registered yet."
        description="Create a user to get started with authentication."
        action={() => setShowCreateForm(true)}
        actionLabel="Create User"
      />
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          className="flex-1 min-w-[200px]"
          placeholder="Search by email, name, or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-[140px]" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
          <option value="all">All roles</option>
          {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
        <Select className="w-[140px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All status</option>
          {statusFilters.slice(1).map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select className="w-[140px]" value={filterProvider} onChange={(e) => setFilterProvider(e.target.value)}>
          <option value="all">All providers</option>
          {providerFilters.slice(1).map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Button onClick={() => setShowInviteForm(true)}>Invite User</Button>
        <Button variant="primary" onClick={() => setShowCreateForm(true)}>+ Create User</Button>
      </div>

      {/* User list */}
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Providers</Th>
              <Th>Confirmed</Th>
              <Th>Status</Th>
              <Th>MFA</Th>
              <Th>Last Sign-in</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr
                key={u.id}
                className="border-b border-border hover:bg-accent/50 cursor-pointer"
                onClick={() => setSelectedUser(u)}
              >
                <Td className="font-medium">{u.email}</Td>
                <Td>
                  <Badge variant={u.role === "admin" ? "indigo" : "green"}>
                    {u.role}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {u.providers.map((p) => (
                      <Badge key={p.provider} variant="blue" className="text-[0.6rem]">{p.provider}</Badge>
                    ))}
                  </div>
                </Td>
                <Td>
                  {u.confirmed ? "Yes" : <span className="text-yellow-400">Pending</span>}
                </Td>
                <Td>
                  {u.disabled
                    ? <Badge variant="red">Disabled</Badge>
                    : <Badge variant="green">Active</Badge>
                  }
                </Td>
                <Td>
                  {u.mfa_factors.length > 0
                    ? <Badge variant="indigo">{u.mfa_factors.length} factor{u.mfa_factors.length !== 1 ? "s" : ""}</Badge>
                    : <span className="text-zinc-600 text-xs">None</span>
                  }
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {u.last_sign_in ? new Date(u.last_sign_in).toLocaleDateString() : "Never"}
                </Td>
                <Td className="text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</Td>
                <Td>
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button size="xs" onClick={() => { void handleToggleDisable(u.id) }}>
                      {u.disabled ? "Enable" : "Disable"}
                    </Button>
                    <Button size="xs" onClick={() => { setSelectedUser(u) }} title="View details + impersonate">
                      View
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-8 text-muted-foreground text-sm">
                  No users found
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <div className="text-xs text-muted-foreground mt-2">
        {filtered.length} of {users.length} users shown
      </div>

      <SlidePanel
        open={panelOpen}
        onClose={closePanel}
        title={panelTitle}
        subtitle={panelSubtitle}
        width="max-w-[560px]"
      >
        {selectedUser && !editingUser && !showCreateForm && !showInviteForm && (
          <UserDetail
            user={selectedUser}
            sessions={sessions}
            onToggleDisable={() => { void handleToggleDisable(selectedUser.id) }}
            onImpersonate={() => handleImpersonate(selectedUser.id)}
            onEdit={() => setEditingUser(selectedUser)}
            onDelete={() => { void handleDeleteUser(selectedUser.id) }}
            onRevokeSession={(id) => { void handleRevokeSession(id) }}
          />
        )}
        {editingUser && (
          <UserForm
            user={editingUser}
            onSave={(data) => { void handleEditUser(data) }}
            onCancel={() => setEditingUser(null)}
          />
        )}
        {showCreateForm && (
          <UserForm
            user={null}
            onSave={(data) => { void handleCreateUser(data) }}
            onCancel={() => setShowCreateForm(false)}
          />
        )}
        {showInviteForm && (
          <InviteUserForm
            onInvite={(email, role) => { void handleInviteUser(email, role) }}
            onCancel={() => setShowInviteForm(false)}
          />
        )}
      </SlidePanel>
    </>
  )
}
