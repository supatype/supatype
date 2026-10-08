/**
 * The engine version the ownership flags need, checked before the CLI sends one.
 *
 * `--overwrite-drift`, `--release`, `--reclaim` and `--rebaseline` (and their `overwrite_drift`,
 * `release`, `reclaim` and `rebaseline` request fields) are read by the ownership ledger, which
 * first shipped in schema-engine 0.7.0. An older binary answers an unknown flag with a usage error
 * that names nothing about the project, and an older engine server ignores an unknown field, so a
 * consent the person gave would be silently dropped. Either way the CLI says so first.
 *
 * Unlike `engine-floor.ts`, which reads only the pin, this resolves an unpinned project to the
 * latest release the way the binary download does: that release is the engine that will run, and
 * until 0.7.0 is out it is older than these flags need.
 */
import { hasEngineOverride, resolveVersionFor, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { compareVersions } from "./engine-floor.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { error } from "./ui/messages.js"

/** First engine release with the ownership ledger's flags (schema-engine v0.7.0). */
export const ENGINE_MIN_FOR_OWNERSHIP = "0.7.0"

/** Why `flag` cannot be sent to an engine at `resolved`, or undefined when it can. */
export function ownershipFlagRefusal(flag: string, resolved: string): string | undefined {
  if (compareVersions(resolved, ENGINE_MIN_FOR_OWNERSHIP) >= 0) return undefined
  return (
    `\`${flag}\` needs Supatype engine ${ENGINE_MIN_FOR_OWNERSHIP} or newer (resolved: ${resolved}). ` +
    `Update or pin versions.engine.`
  )
}

/**
 * The engine version this project runs, or undefined when it cannot be known: a local build
 * (`overrides.engine`, or `versions.engine: "local"`) reports no version the config can compare.
 */
export async function resolvedEngineVersion(
  config: SupatypeProjectConfig,
  resolve: typeof resolveVersionFor = resolveVersionFor,
): Promise<string | undefined> {
  if (hasEngineOverride(config)) return undefined
  const version = await resolve("engine", config)
  return version === VERSION_PIN_LOCAL ? undefined : version
}

/**
 * Exit 1 before sending `flag` when the resolved engine is older than the ledger. Call it only when
 * the flag (or its request field) is about to be sent.
 */
export async function requireEngineForOwnershipFlag(
  flag: string,
  config: SupatypeProjectConfig,
  resolve: typeof resolveVersionFor = resolveVersionFor,
): Promise<void> {
  const version = await resolvedEngineVersion(config, resolve)
  if (version === undefined) return
  const refusal = ownershipFlagRefusal(flag, version)
  if (refusal === undefined) return
  error(refusal)
  process.exit(1)
}
