import type { DefectId } from "./defects.js"
import type { Tier } from "./stack.js"
import type { Caller } from "./world.js"

/**
 * Which open defects stop a caller's correct result on a channel today, in one place so a fix that
 * lands is un-marked once rather than in every spec. REST, writes and realtime hold in both tiers.
 *
 * GraphQL under this suite's tier 2 is still wrong for end users (T2-N6): the CLI decides the
 * GraphQL search path from the tier it derives from the config (`supatype/postgres` means tier 1),
 * not from an explicit `schema.api_schemas`, so a stack whose database lost `supatype_mask` keeps
 * reflecting `public`. service_role sees the base tables, which is everything, as it should.
 */
export function graphqlDefects(tier: Tier, caller: Caller): DefectId[] {
  if (tier === 1) return []
  return caller === "anon" || caller === "service_role" ? [] : ["T2-N6"]
}
