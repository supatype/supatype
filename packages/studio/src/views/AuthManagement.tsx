import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Badge, Button, Card, Input, Select, Th, Td } from "../components/ui.js"

interface AuthUser {
  id: string
  email: string
  role: string
  confirmed: boolean
  disabled: boolean
  last_sign_in: string | null
  created_at: string
}

const mockUsers: AuthUser[] = [
  { id: "u1", email: "alice@example.com", role: "authenticated", confirmed: true, disabled: false, last_sign_in: "2026-03-10T08:00:00Z", created_at: "2026-01-15T10:30:00Z" },
  { id: "u2", email: "bob@example.com", role: "authenticated", confirmed: true, disabled: false, last_sign_in: "2026-03-09T14:20:00Z", created_at: "2026-02-01T14:20:00Z" },
  { id: "u3", email: "carol@example.com", role: "admin", confirmed: true, disabled: false, last_sign_in: "2026-03-10T09:15:00Z", created_at: "2026-02-14T09:15:00Z" },
  { id: "u4", email: "dave@example.com", role: "authenticated", confirmed: false, disabled: false, last_sign_in: null, created_at: "2026-03-01T16:45:00Z" },
  { id: "u5", email: "eve@example.com", role: "authenticated", confirmed: true, disabled: true, last_sign_in: "2026-02-20T11:00:00Z", created_at: "2026-01-20T12:00:00Z" },
]

const availableRoles = ["authenticated", "admin", "moderator"]

export function AuthManagement(): React.ReactElement {
  const client = useStudioClient()
  const [users, setUsers] = useState<AuthUser[]>(mockUsers)
  const [search, setSearch] = useState("")
  const [filterRole, setFilterRole] = useState<string>("all")
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null)
  const [editRole, setEditRole] = useState("")

  const filtered = users.filter((u) => {
    if (search && !u.email.toLowerCase().includes(search.toLowerCase())) return false
    if (filterRole !== "all" && u.role !== filterRole) return false
    return true
  })

  const toggleDisable = (userId: string) => {
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, disabled: !u.disabled } : u))
  }

  const handleRoleChange = (userId: string, newRole: string) => {
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole } : u))
    setEditingUser(null)
  }

  return (
    <>
      {/* Search & filter bar */}
      <div className="flex gap-2 mb-4">
        <Input
          className="flex-1"
          placeholder="Search by email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-40" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
          <option value="all">All roles</option>
          {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
      </div>

      {/* User table */}
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Confirmed</Th>
              <Th>Status</Th>
              <Th>Last Sign-in</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-b border-border hover:bg-accent/50">
                <Td className="font-medium">{u.email}</Td>
                <Td>
                  {editingUser?.id === u.id ? (
                    <Select
                      className="w-[130px] px-1 py-0.5 text-sm"
                      value={editRole}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      autoFocus
                      onBlur={() => setEditingUser(null)}
                    >
                      {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  ) : (
                    <Badge
                      variant={u.role === "admin" ? "indigo" : "green"}
                      className="cursor-pointer"
                      onClick={() => { setEditingUser(u); setEditRole(u.role) }}
                    >
                      {u.role}
                    </Badge>
                  )}
                </Td>
                <Td>{u.confirmed ? "Yes" : <span className="text-yellow-400">Pending</span>}</Td>
                <Td>
                  {u.disabled
                    ? <Badge variant="red">Disabled</Badge>
                    : <Badge variant="green">Active</Badge>
                  }
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {u.last_sign_in ? new Date(u.last_sign_in).toLocaleDateString() : "Never"}
                </Td>
                <Td className="text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button onClick={() => toggleDisable(u.id)}>
                      {u.disabled ? "Enable" : "Disable"}
                    </Button>
                    <Button title="Sign in as this user (impersonate)">
                      Impersonate
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
