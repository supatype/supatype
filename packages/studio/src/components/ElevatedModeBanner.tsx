import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useStudioCapability } from "../hooks/useStudioCapability.js"

/**
 * Tracks whether anything currently on screen is project data read past RLS.
 *
 * The banner used to be mounted once, above every view, which made it a claim about Studio rather
 * than about what you were looking at. On the Rules tab, or API docs, or settings, there are no
 * rows on screen for RLS to have been bypassed for, and a warning that is always present is one
 * nobody reads by the time it matters.
 *
 * A count rather than a boolean: a list view holding a slide-over editor has two registrants, and
 * closing the editor must not retract a notice the list behind it still needs.
 */
const ElevatedNoticeContext = createContext<{
  active: boolean
  register: () => () => void
}>({
  active: false,
  register: () => () => {},
})

export function ElevatedNoticeProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [count, setCount] = useState(0)

  const register = useCallback(() => {
    setCount((n) => n + 1)
    return () => setCount((n) => n - 1)
  }, [])

  const value = useMemo(() => ({ active: count > 0, register }), [count, register])

  return (
    <ElevatedNoticeContext.Provider value={value}>{children}</ElevatedNoticeContext.Provider>
  )
}

/**
 * Declare that this view puts project rows on screen.
 *
 * Call it from any view that renders records the project's own policies would filter. Opting in is
 * deliberate: a view that shows engine metadata, docs or settings is reading nothing a policy
 * applies to, and inheriting the warning by default is what made it meaningless.
 */
export function useShowsProjectRows(): void {
  const { register } = useContext(ElevatedNoticeContext)
  useEffect(() => register(), [register])
}

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
  const { active } = useContext(ElevatedNoticeContext)

  if (mode !== "elevated" || !active) return null

  return (
    <div
      role="status"
      className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md text-xs border border-amber-500/30 bg-amber-500/10 text-amber-200"
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
