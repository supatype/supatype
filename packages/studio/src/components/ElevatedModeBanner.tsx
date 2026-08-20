import React from "react"
import { useStudioCapability } from "../hooks/useStudioCapability.js"

/**
 * Says when Studio is reading past Row Level Security.
 *
 * Elevated access is legitimate, administering a project means seeing rows your
 * own policies would hide, but it must never be silent. Without this, an admin
 * cannot tell whether an empty table means "no rows" or "no rows *you* can see",
 * and cannot tell that what they are looking at is more than their application
 * would ever return.
 *
 * The mode comes from the server's own answer, not from the role name: the client
 * has no business deciding what privilege it holds.
 */
export function ElevatedModeBanner(): React.ReactElement | null {
  const { mode, role } = useStudioCapability()

  if (mode !== "elevated") return null

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-amber-500/30 bg-amber-500/10 text-amber-200"
    >
      <span aria-hidden="true">⚠</span>
      <span>
        <strong className="font-medium">Elevated access</strong>: Row Level Security
        does not apply to what you are seeing
        {role !== null ? <> (Studio role: {role})</> : null}. Every change you make
        here is recorded.
      </span>
    </div>
  )
}
