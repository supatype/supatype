import React from "react"
import { Badge, Select } from "./ui.js"
import type { UseStudioMembersReturn } from "../hooks/useStudioMembers.js"

interface StudioAccessCellProps {
  userId: string
  members: UseStudioMembersReturn
  /** The signed-in user, so their own row is read-only. */
  currentUserId: string | null
  /** Whether the viewer may change anyone's access at all. */
  canManage: boolean
}

/**
 * A user's Studio role, editable in place by an admin.
 *
 * This is *Studio* access, Supatype's own namespace, not the application roles
 * the developer defines for their own users. Those live in the developer's claims
 * and tables and are theirs to manage; the two are shown apart on purpose, because
 * conflating them is how granting an app role could hand out admin UI access.
 */
export function StudioAccessCell({
  userId,
  members,
  currentUserId,
  canManage,
}: StudioAccessCellProps): React.ReactElement {
  const role = members.roleFor(userId)
  const isSelf = currentUserId !== null && currentUserId === userId

  if (!canManage) {
    return role === null ? <NoAccess /> : <Badge variant="indigo">{role}</Badge>
  }

  // Nobody may change their own role: self-promotion is the escalation this whole
  // design prevents, and self-demotion can strand a project. The server refuses it
  // regardless; showing it disabled explains why rather than failing on click.
  if (isSelf) {
    return (
      <div className="flex items-center gap-2">
        {role === null ? <NoAccess /> : <Badge variant="indigo">{role}</Badge>}
        <span className="text-[0.6rem] text-muted-foreground">you</span>
      </div>
    )
  }

  return (
    <Select
      className="w-[130px]"
      value={role ?? ""}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation()
        const next = e.target.value
        void (next === "" ? members.revoke(userId) : members.setRole(userId, next))
      }}
    >
      <option value="">No access</option>
      {members.roles.map((r) => (
        <option key={r.role} value={r.role}>
          {r.role}
        </option>
      ))}
    </Select>
  )
}

function NoAccess(): React.ReactElement {
  return <span className="text-xs text-muted-foreground">No access</span>
}
