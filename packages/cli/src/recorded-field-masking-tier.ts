/**
 * The field-masking tier the project's own database actually has, as the engine recorded it.
 *
 * The CLI predicts the tier from the image before any database exists (`field-masking-tier.ts`),
 * and compose is first written with that prediction. The engine then decides for real on every
 * push, by asking Postgres whether `supatype_mask` is installed, and records the answer in
 * `_supatype.schema_state.capabilities.fieldMasking.tier`. The two differ when the database is not
 * what its image promised: `supatype/postgres` with the extension dropped runs tier 2, and a
 * PostgREST still searching `public` then gives GraphQL no model for any end user (T2-N6).
 *
 * So once a push has recorded a tier, the record wins. After each push to the project's own stack
 * it is read back and kept in `.supatype/field-masking-tier.json`, and compose is rendered from one
 * resolution (`resolveFieldMaskingTier` in `self-host-compose.ts`): the caller's explicit tier,
 * else the recorded tier, else the prediction. A database replaced since is corrected by its next
 * push, which `dev` always makes before PostgREST starts.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { composeDbPsql, type ComposeStack } from "./compose-db-psql.js"
import type { FieldMaskingTier } from "./field-masking-tier.js"

const RECORDED_TIER_QUERY =
  "SELECT capabilities->'fieldMasking'->>'tier' FROM _supatype.schema_state WHERE id = 1"

/** Where the recorded tier is kept between commands. */
export function recordedTierPath(cwd: string): string {
  return join(cwd, ".supatype", "field-masking-tier.json")
}

function isFieldMaskingTier(value: unknown): value is FieldMaskingTier {
  return value === "none" || value === "extension" || value === "views"
}

/**
 * The engine's name for a tier, as the CLI's. `broken` (field rules with neither the extension nor
 * the views) has no PostgREST setting that serves it correctly, so it and anything unknown give
 * undefined, and the prediction stands.
 */
export function tierFromEngine(recorded: string): FieldMaskingTier | undefined {
  switch (recorded.trim()) {
    case "extension":
      return "extension"
    case "views":
      return "views"
    case "unenforced":
      return "none"
    default:
      return undefined
  }
}

/** The tier the last push to this project's stack recorded, or undefined before there is one. */
export function readRecordedTier(cwd: string): FieldMaskingTier | undefined {
  const path = recordedTierPath(cwd)
  if (!existsSync(path)) return undefined
  try {
    const tier = (JSON.parse(readFileSync(path, "utf8")) as { tier?: unknown } | null)?.tier
    return isFieldMaskingTier(tier) ? tier : undefined
  } catch {
    // A file that does not parse says nothing about the database; the next push rewrites it.
    return undefined
  }
}

export function writeRecordedTier(cwd: string, tier: FieldMaskingTier): void {
  const path = recordedTierPath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ tier }, null, 2)}\n`, "utf8")
}

/**
 * The tier `stack`'s database recorded on its last push, read in its `db` container. Undefined
 * when it cannot be read (no stack, no push yet, a pre-0.7 engine), which leaves the prediction.
 */
export function queryRecordedTier(cwd: string, stack: ComposeStack): FieldMaskingTier | undefined {
  const { args, env } = composeDbPsql(cwd, stack, ["-tAc", RECORDED_TIER_QUERY])
  const result = spawnSync("docker", args, { cwd: dirname(stack.composePath), encoding: "utf8", env })
  if (result.status !== 0) return undefined
  return tierFromEngine(result.stdout ?? "")
}

/**
 * Read `stack`'s recorded tier and keep it. True when it is new, so compose has to be rendered
 * again for PostgREST to follow it.
 */
export function syncRecordedTier(cwd: string, stack: ComposeStack): boolean {
  const recorded = queryRecordedTier(cwd, stack)
  if (recorded === undefined || recorded === readRecordedTier(cwd)) return false
  writeRecordedTier(cwd, recorded)
  return true
}
