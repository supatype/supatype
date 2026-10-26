import type { DefectId } from "./defects.js"
import type { Tier } from "./stack.js"
import type { Caller } from "./world.js"

/**
 * Which open defects stop a caller's correct result on each channel today. One place, so a fix that
 * lands is un-marked once rather than in every spec.
 *
 * Tier 1 (supatype_mask): only the admin is wrong, because T1-N1 leaves Role<> rules dead on a
 * fresh stack. Tier 2 (the api views, as shipped): every signed-in caller is refused outright
 * (A3-N3), and service_role is masked like a stranger (T2-N5).
 */
export function restReadDefects(tier: Tier, caller: Caller): DefectId[] {
  if (tier === 1) return caller === "admin" ? ["T1-N1"] : []
  if (caller === "service_role") return ["T2-N5"]
  return caller === "anon" ? [] : ["A3-N3"]
}

/** Tier 2's GraphQL reflects no model for an end user (T2-N6); service_role sees the base tables. */
export function graphqlDefects(tier: Tier, caller: Caller): DefectId[] {
  if (tier === 1) return caller === "admin" ? ["T1-N1"] : []
  return caller === "anon" || caller === "service_role" ? [] : ["T2-N6"]
}

/**
 * Updates through a tier-2 view: refused outright today (A3-N3), and once that is fixed the stale
 * mask labels on supatype/postgres still fail them (T2-N7).
 */
export function tier2UpdateDefects(): DefectId[] {
  return ["A3-N3", "T2-N7"]
}
