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

const SWITCH_LABELS: Record<ActingMode, string> = {
  self: "Act as myself",
  studio: "Edit as Studio",
  elevated: "Use elevated access",
}

/**
 * The control that switches a Studio user between acting as Studio, acting as themselves and, for
 * a role that may, elevated access (RX4). The choice is remembered and sent on every request
 * (`acting-mode.ts`); the server decides whether it may be had. Studio is the default, so choosing
 * it forgets the choice.
 */
function ActingModeSwitch({ to, onSwitched }: { to: ActingMode; onSwitched: () => void }): React.ReactElement {
  const client = useAdminClient()
  const choose = (): void => {
    chooseActingMode(client.url, to === "studio" ? null : to)
    onSwitched()
  }
  return (
    <Button size="sm" variant="secondary" className="shrink-0" onClick={choose}>
      {SWITCH_LABELS[to]}
    </Button>
  )
}

/** The switches to every mode but `current` this user may have, at the end of a notice. */
function ModeSwitches({ current, canElevate, onSwitched }: {
  current: ActingMode
  canElevate: boolean
  onSwitched: () => void
}): React.ReactElement {
  const modes: ActingMode[] = canElevate ? ["studio", "self", "elevated"] : ["studio", "self"]
  return (
    <span className="ml-auto flex gap-2">
      {modes.filter((mode) => mode !== current).map((mode) => (
        <ActingModeSwitch key={mode} to={mode} onSwitched={onSwitched} />
      ))}
    </span>
  )
}

/**
 * Says which identity Studio's requests act as, while project rows are on screen.
 *
 * Acting as Studio, the Studio role decides what may be done with rows and the app's field rules
 * still apply. Elevated access is legitimate, administering a project means seeing rows your own
 * policies would hide, but it must never be silent. Acting as yourself shows the app's own rules.
 * Every role that reads content may switch between Studio and themselves; a role that may elevate
 * may switch to elevated access too.
 *
 * The mode comes from the server's own answer, not from the role name: the client has no business
 * deciding what privilege it holds.
 */
export function ElevatedModeBanner({ onSwitched = reloadStudio }: { onSwitched?: () => void } = {}): React.ReactElement | null {
  const { mode, role, canElevate, permissions } = useStudioCapability()
  const { active } = useContext(ElevatedNoticeContext)
  if (!active) return null
  // Nothing to say before the server has answered, or to a role that reads no content.
  if (role === null || (permissions["read"] !== true && !canElevate)) return null

  const switches = <ModeSwitches current={mode} canElevate={canElevate} onSwitched={onSwitched} />
  if (mode === "studio") return <StudioModeNotice role={role}>{switches}</StudioModeNotice>
  if (mode === "self") return <SelfModeNotice>{switches}</SelfModeNotice>
  return (
    <ElevatedNotice>
      <span>
        <strong className="font-medium">Elevated access</strong>: Row Level Security
        does not apply to what you are seeing (Studio role: {role}). Every change you make
        here is recorded.
      </span>
      {switches}
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

/** The quiet strip for a mode that applies rules: what they are, and the switches. */
function ModeNotice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div role="status" className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md text-xs border border-border bg-muted text-muted-foreground">
      {children}
    </div>
  )
}

/** Acting as Studio, the default: the Studio role decides, field rules still apply. */
function StudioModeNotice({ role, children }: { role: string; children: React.ReactNode }): React.ReactElement {
  return (
    <ModeNotice>
      <span>
        <strong className="font-medium text-foreground">Editing as Studio</strong>: your Studio role
        ({role}) decides what you can do here. This project&apos;s row rules do not apply; its field
        rules do, so masked fields stay masked. Every change you make is recorded.
      </span>
      {children}
    </ModeNotice>
  )
}

/** Acting as yourself: what the app's own rules show this user, and the way back. */
function SelfModeNotice({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <ModeNotice>
      <span>
        <strong className="font-medium text-foreground">Acting as yourself</strong>: this project&apos;s
        access rules apply to what you are seeing, as your app applies them to you.
      </span>
      {children}
    </ModeNotice>
  )
}
