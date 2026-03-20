import React, { useState, useCallback } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

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
  last_active: string
  created_at: string
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockUsers: AuthUser[] = [
  {
    id: "u1", email: "alice@example.com", phone: "+44 7700 900123", role: "authenticated",
    confirmed: true, disabled: false, last_sign_in: "2026-03-10T08:00:00Z",
    created_at: "2026-01-15T10:30:00Z", updated_at: "2026-03-10T08:00:00Z",
    metadata: { full_name: "Alice Johnson", avatar_url: "https://i.pravatar.cc/40?u=alice" },
    providers: [
      { provider: "email", provider_id: "alice@example.com", linked_at: "2026-01-15T10:30:00Z" },
      { provider: "github", provider_id: "alice-gh", linked_at: "2026-02-01T09:00:00Z" },
    ],
    mfa_factors: [
      { id: "f1", type: "totp", friendly_name: "Authenticator", created_at: "2026-02-15T10:00:00Z", verified: true },
    ],
  },
  {
    id: "u2", email: "bob@example.com", phone: null, role: "authenticated",
    confirmed: true, disabled: false, last_sign_in: "2026-03-09T14:20:00Z",
    created_at: "2026-02-01T14:20:00Z", updated_at: "2026-03-09T14:20:00Z",
    metadata: { full_name: "Bob Smith" },
    providers: [{ provider: "email", provider_id: "bob@example.com", linked_at: "2026-02-01T14:20:00Z" }],
    mfa_factors: [],
  },
  {
    id: "u3", email: "carol@example.com", phone: null, role: "admin",
    confirmed: true, disabled: false, last_sign_in: "2026-03-10T09:15:00Z",
    created_at: "2026-02-14T09:15:00Z", updated_at: "2026-03-10T09:15:00Z",
    metadata: { full_name: "Carol Davis" },
    providers: [
      { provider: "email", provider_id: "carol@example.com", linked_at: "2026-02-14T09:15:00Z" },
      { provider: "google", provider_id: "carol-google", linked_at: "2026-02-20T11:00:00Z" },
    ],
    mfa_factors: [],
  },
  {
    id: "u4", email: "dave@example.com", phone: null, role: "authenticated",
    confirmed: false, disabled: false, last_sign_in: null,
    created_at: "2026-03-01T16:45:00Z", updated_at: "2026-03-01T16:45:00Z",
    metadata: {},
    providers: [{ provider: "email", provider_id: "dave@example.com", linked_at: "2026-03-01T16:45:00Z" }],
    mfa_factors: [],
  },
  {
    id: "u5", email: "eve@example.com", phone: "+1 555 0100", role: "authenticated",
    confirmed: true, disabled: true, last_sign_in: "2026-02-20T11:00:00Z",
    created_at: "2026-01-20T12:00:00Z", updated_at: "2026-02-25T10:00:00Z",
    metadata: { full_name: "Eve Wilson" },
    providers: [{ provider: "email", provider_id: "eve@example.com", linked_at: "2026-01-20T12:00:00Z" }],
    mfa_factors: [],
  },
]

const mockSessions: AuthSession[] = [
  { id: "s1", user_id: "u1", ip: "192.168.1.10", user_agent: "Chrome/120.0 (macOS)", last_active: "2026-03-10T08:00:00Z", created_at: "2026-03-10T07:30:00Z" },
  { id: "s2", user_id: "u1", ip: "10.0.0.5", user_agent: "Safari/17.3 (iOS)", last_active: "2026-03-09T22:15:00Z", created_at: "2026-03-09T20:00:00Z" },
  { id: "s3", user_id: "u3", ip: "192.168.1.20", user_agent: "Firefox/122.0 (Windows)", last_active: "2026-03-10T09:15:00Z", created_at: "2026-03-10T09:00:00Z" },
]

const availableRoles = ["authenticated", "admin", "moderator", "editor"]
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
  const [role, setRole] = useState(user?.role ?? "authenticated")
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
    <Card className="p-4">
      <h3 className="m-0 mb-4">{user ? "Edit User" : "Create User"}</h3>
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
          <Select className="w-full" value={role} onChange={(e) => setRole(e.target.value)}>
            {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
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
    </Card>
  )
}

// ─── User Detail View ─────────────────────────────────────────────────────────

function UserDetail({
  user,
  sessions,
  onClose,
  onToggleDisable,
  onImpersonate,
  onEdit,
  onDelete,
  onRevokeSession,
}: {
  user: AuthUser
  sessions: AuthSession[]
  onClose: () => void
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
    <Card className="p-4">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="m-0">{user.email}</h3>
          <code className="text-[0.7rem] text-zinc-600">{user.id}</code>
        </div>
        <Button onClick={onClose}>Close</Button>
      </div>

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
                    <Td className="text-xs">{s.user_agent}</Td>
                    <Td className="font-mono text-xs">{s.ip}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(s.last_active).toLocaleString()}</Td>
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
    </Card>
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
  const [role, setRole] = useState("authenticated")

  return (
    <Card className="p-4">
      <h3 className="m-0 mb-3">Invite User</h3>
      <p className="text-xs text-muted-foreground mb-3">
        An invitation email will be sent to the user with a magic link to confirm their account.
      </p>
      <div className="flex gap-2 items-end max-w-[500px]">
        <div className="flex-1">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
        </div>
        <div className="w-[140px]">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Role</label>
          <Select className="w-full" value={role} onChange={(e) => setRole(e.target.value)}>
            {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>
        <Button variant="primary" onClick={() => { if (email.trim()) onInvite(email.trim(), role) }}>
          Send Invite
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AuthManagement(): React.ReactElement {
  const client = useStudioClient()

  const [users, setUsers] = useState<AuthUser[]>(mockUsers)
  const [sessions, setSessions] = useState<AuthSession[]>(mockSessions)

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

  const handleToggleDisable = (userId: string) => {
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, disabled: !u.disabled } : u))
    if (selectedUser?.id === userId) {
      setSelectedUser((prev) => prev ? { ...prev, disabled: !prev.disabled } : null)
    }
  }

  const handleDeleteUser = (userId: string) => {
    setUsers((prev) => prev.filter((u) => u.id !== userId))
    setSessions((prev) => prev.filter((s) => s.user_id !== userId))
    setSelectedUser(null)
  }

  const handleCreateUser = (data: { email: string; role: string; password?: string; metadata: Record<string, unknown> }) => {
    const newUser: AuthUser = {
      id: `u${Date.now()}`,
      email: data.email,
      phone: null,
      role: data.role,
      confirmed: false,
      disabled: false,
      last_sign_in: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: data.metadata,
      providers: [{ provider: "email", provider_id: data.email, linked_at: new Date().toISOString() }],
      mfa_factors: [],
    }
    setUsers((prev) => [newUser, ...prev])
    setShowCreateForm(false)
  }

  const handleEditUser = (data: { email: string; role: string; password?: string; metadata: Record<string, unknown> }) => {
    if (!editingUser) return
    setUsers((prev) => prev.map((u) => u.id === editingUser.id ? { ...u, email: data.email, role: data.role, metadata: data.metadata, updated_at: new Date().toISOString() } : u))
    setEditingUser(null)
    setSelectedUser(null)
  }

  const handleInviteUser = (email: string, role: string) => {
    // In production: POST to auth invite endpoint
    const newUser: AuthUser = {
      id: `u${Date.now()}`,
      email,
      phone: null,
      role,
      confirmed: false,
      disabled: false,
      last_sign_in: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
      providers: [{ provider: "email", provider_id: email, linked_at: new Date().toISOString() }],
      mfa_factors: [],
    }
    setUsers((prev) => [newUser, ...prev])
    setShowInviteForm(false)
  }

  const handleRevokeSession = (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
  }

  const handleImpersonate = (userId: string) => {
    // In production: generate short-lived JWT via admin API
    // For now, just show info in the detail view
  }

  // Show detail view or form
  if (selectedUser && !editingUser) {
    return (
      <UserDetail
        user={selectedUser}
        sessions={sessions}
        onClose={() => setSelectedUser(null)}
        onToggleDisable={() => handleToggleDisable(selectedUser.id)}
        onImpersonate={() => handleImpersonate(selectedUser.id)}
        onEdit={() => setEditingUser(selectedUser)}
        onDelete={() => handleDeleteUser(selectedUser.id)}
        onRevokeSession={handleRevokeSession}
      />
    )
  }

  if (editingUser) {
    return (
      <UserForm
        user={editingUser}
        onSave={handleEditUser}
        onCancel={() => setEditingUser(null)}
      />
    )
  }

  if (showCreateForm) {
    return (
      <UserForm
        user={null}
        onSave={handleCreateUser}
        onCancel={() => setShowCreateForm(false)}
      />
    )
  }

  if (showInviteForm) {
    return (
      <InviteUserForm
        onInvite={handleInviteUser}
        onCancel={() => setShowInviteForm(false)}
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
                    <Button size="xs" onClick={() => handleToggleDisable(u.id)}>
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
    </>
  )
}
