import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { chooseActingMode, type ActingMode } from "../lib/acting-mode.js"
import { Button } from "./ui.js"

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

/** Whether a view that puts project rows on screen is mounted: what notices about those rows wait for. */
export function useProjectRowsOnScreen(): boolean {
  return useContext(ElevatedNoticeContext).active
}

/** Reload Studio once the mode changes, so every view reads again in the new mode. */
function reloadStudio(): void {
  window.location.reload()
}

/**
 * The control that switches an owner or admin between elevated access and acting as themselves
 * (RX4). The choice is remembered and sent on every request (`acting-mode.ts`); the server decides
 * whether it may be had.
 */
function ActingModeSwitch({ to, onSwitched }: { to: ActingMode; onSwitched: () => void }): React.ReactElement {
  const client = useAdminClient()
  const choose = (): void => {
    chooseActingMode(client.url, to)
    onSwitched()
  }
  return (
    <Button size="sm" variant="secondary" className="ml-auto shrink-0" onClick={choose}>
      {to === "self" ? "Act as myself" : "Use elevated access"}
    </Button>
  )
}

/**
 * Says which identity Studio's requests act as, while project rows are on screen.
 *
 * Elevated access is legitimate, administering a project means seeing rows your
 * own policies would hide, but it must never be silent. Without this, an admin
 * cannot tell whether an empty table means "no rows" or "no rows *you* can see",
 * and cannot tell that what they are looking at is more than their application
 * would ever return. A role that may elevate can switch from here, either way; a
 * role that cannot is always itself, and is told nothing it cannot change.
 *
 * The mode comes from the server's own answer, not from the role name: the client
 * has no business deciding what privilege it holds.
 */
export function ElevatedModeBanner({ onSwitched = reloadStudio }: { onSwitched?: () => void } = {}): React.ReactElement | null {
  const { mode, role, canElevate } = useStudioCapability()
  const { active } = useContext(ElevatedNoticeContext)

  if (!active) return null
  if (mode !== "elevated") return canElevate ? <SelfModeNotice onSwitched={onSwitched} /> : null

  return (
    <ElevatedNotice>
      <span>
        <strong className="font-medium">Elevated access</strong>: Row Level Security
        does not apply to what you are seeing
        {role !== null ? <> (Studio role: {role})</> : null}. Every change you make
        here is recorded.
      </span>
      {canElevate ? <ActingModeSwitch to="self" onSwitched={onSwitched} /> : null}
    </ElevatedNotice>
  )
}

/** The warning strip for anything on screen that was read past Row Level Security. */
export function ElevatedNotice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      role="status"
      className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md text-xs border border-amber-500/30 bg-amber-500/10 text-amber-200"
    >
      <span aria-hidden="true">⚠</span>
      {children}
    </div>
  )
}

/** An owner or admin who switched to acting as themselves: what they see, and the way back. */
function SelfModeNotice({ onSwitched }: { onSwitched: () => void }): React.ReactElement {
  return (
    <div role="status" className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md text-xs border border-border bg-muted text-muted-foreground">
      <span>
        <strong className="font-medium text-foreground">Acting as yourself</strong>: this project&apos;s
        access rules apply to what you are seeing, as your app applies them to you.
      </span>
      <ActingModeSwitch to="elevated" onSwitched={onSwitched} />
    </div>
  )
}
