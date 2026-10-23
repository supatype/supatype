import React, { createContext, useContext } from "react"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { firstNeed, offersAny } from "../lib/capability-offers.js"
import { roleRefusal, roleRefusalText } from "../lib/role-refusal.js"
import { EmptyState } from "./EmptyState.js"

/**
 * What one screen, tab or panel needs: a permission from the shared role matrix, and what it lets
 * someone do, in words that finish "Your Studio role (editor) can't ...".
 */
export interface RoleRequirement {
  /** The permission, or permissions any one of which opens it. */
  needs: string | readonly string[]
  activity: string
}

interface GateAnswer extends RoleRequirement {
  role: string | null
}

const RoleGateContext = createContext<GateAnswer | null>(null)

export interface RoleGateProps extends RoleRequirement {
  children: React.ReactNode
}

/**
 * Renders `children` for a role that holds `needs`, and otherwise says plainly why there is nothing
 * here. Each screen states its own requirement where it is mounted, so a new screen inherits none.
 *
 * Nothing renders until the server has answered, so a screen's controls never show for a moment
 * and then vanish. A host that reports no role withholds nothing; the server still refuses.
 */
export function RoleGate({ needs, activity, children }: RoleGateProps): React.ReactElement | null {
  const capability = useStudioCapability()
  if (!capability.settled) return null
  const answer = { needs, activity, role: capability.role }
  if (!offersAny(capability, needs)) return <RoleDenied {...answer} />
  return <RoleGateContext.Provider value={answer}>{children}</RoleGateContext.Provider>
}

/** The plain refusal a screen shows in its place. */
export function RoleDenied({ role, needs, activity }: GateAnswer): React.ReactElement {
  const refusal = roleRefusal(role, firstNeed(needs), activity)
  return <EmptyState title={refusal.headline} description={refusal.ask} />
}

/**
 * The line a 403 from the Studio proxy reads as on this screen: the enclosing gate's sentence, so a
 * refusal the gate did not foresee says the same as one it did.
 */
export function useRoleRefusalText(): string {
  const gate = useContext(RoleGateContext)
  return roleRefusalText(roleRefusal(gate?.role ?? null, firstNeed(gate?.needs ?? "administer"), gate?.activity ?? "do this"))
}
