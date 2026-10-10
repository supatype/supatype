/**
 * What the engine (or the server in front of it) says it supports, checked before the CLI sends an
 * ownership flag.
 *
 * An older engine binary answers an unknown flag with a usage error that names nothing about the
 * project, and an older engine server, or a control plane that does not forward the field, ignores
 * it: a consent the person gave would be silently dropped, or an adopt of nothing would adopt
 * everything. So the CLI asks first and refuses, naming the flag, rather than send it and degrade.
 *
 * - A linked (cloud or self-host) target answers `GET <schema base>/capabilities`. No route (404)
 *   means a server from before this check, which supports none of them.
 * - The engine binary answers `supatype-engine capabilities`. One from before the subcommand is
 *   judged by its version: the ledger's first release had the flags listed in
 *   `LEGACY_OWNERSHIP_FEATURES`, and nothing older had any.
 *
 * Always the binary that will run (an override, a cached release offline), never the CDN's latest.
 */
import { spawnSync } from "node:child_process"
import { engineBinPath } from "./engine-client.js"
import { compareVersions } from "./engine-floor.js"

/** Every feature this CLI may need, as the engine's `capabilities` names them. */
export const OWNERSHIP_FEATURES = [
  "adopt_keys",
  "adopt_none",
  "release",
  "reclaim",
  "rebaseline",
  "accept_access_drift",
  "overwrite_drift",
  "engine_busy",
  // Not an ownership flag: a field's `identity` / `generated` (identity-contract). An engine without
  // it ignores both and makes a plain column, so a schema declaring either is refused instead.
  "identity_columns",
] as const

export type OwnershipFeature = (typeof OWNERSHIP_FEATURES)[number]

/** A feature about to be used, and the flag a person would know it by. */
export interface FeatureNeed {
  feature: OwnershipFeature
  flag: string
}

/** What an engine or a server says it supports; `source` names it in a refusal. */
export interface Capabilities {
  features: ReadonlySet<string>
  source: "server" | "engine"
}

/**
 * What sending `keys` to adopt needs: only those conflicts (`adopt_keys`), or for an empty list
 * none of them (`adopt_none`), which an engine without it would read as every conflict.
 */
export function adoptKeysNeed(keys: readonly string[]): FeatureNeed {
  return keys.length === 0 ? { feature: "adopt_none", flag: "--adopt-none" } : { feature: "adopt_keys", flag: "--key" }
}

/** What an adopt request needs from the engine, from the fields it is about to send. */
export function adoptNeeds(opts: {
  keys?: readonly string[] | undefined
  release?: readonly string[] | undefined
  reclaim?: readonly string[] | undefined
}): FeatureNeed[] {
  const needs: FeatureNeed[] = []
  if ((opts.release ?? []).length > 0) needs.push({ feature: "release", flag: "--release" })
  if ((opts.reclaim ?? []).length > 0) needs.push({ feature: "reclaim", flag: "--reclaim" })
  if (opts.keys !== undefined) needs.push(adoptKeysNeed(opts.keys))
  return needs
}

/**
 * What sending `ast` needs for its identity and generated columns, which an engine or server
 * without `identity_columns` would drop: none when it declares neither.
 */
export function identityColumnsNeed(ast: unknown): FeatureNeed[] {
  const models = (ast as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return []
  const fields: string[] = []
  for (const model of models as { name?: string; fields?: Record<string, Record<string, unknown>> }[]) {
    for (const [name, field] of Object.entries(model.fields ?? {})) {
      if (field["identity"] !== undefined || field["generated"] !== undefined) fields.push(`${model.name}.${name}`)
    }
  }
  if (fields.length === 0) return []
  return [{ feature: "identity_columns", flag: `identity and generated columns (${fields.join(", ")})` }]
}

/** First engine release with the ownership ledger's flags (schema-engine v0.7.0). */
export const ENGINE_MIN_FOR_OWNERSHIP = "0.7.0"

/**
 * What an engine binary from before `capabilities` supports when it is at least
 * `ENGINE_MIN_FOR_OWNERSHIP`. `adopt_none` and `accept_access_drift` came with `capabilities`.
 */
export const LEGACY_OWNERSHIP_FEATURES: readonly OwnershipFeature[] = [
  "adopt_keys",
  "release",
  "reclaim",
  "rebaseline",
  "overwrite_drift",
]

/** A flag the engine or server cannot honour. Thrown before anything is sent. */
export class OwnershipUnsupportedError extends Error {
  constructor(
    message: string,
    public readonly need: FeatureNeed,
  ) {
    super(message)
    this.name = "OwnershipUnsupportedError"
  }
}

/** Why `need` cannot be sent to what answered `caps`, or undefined when it can. */
export function capabilityRefusal(need: FeatureNeed, caps: Capabilities): string | undefined {
  if (caps.features.has(need.feature)) return undefined
  // A schema, not a flag: what it asks for can also be done by hand.
  const byHand =
    need.feature === "identity_columns"
      ? ", or declare those fields as plain columns and make the change in the database yourself"
      : ""
  return caps.source === "server"
    ? `this server does not support ${need.flag}; update it${byHand}`
    : `this Supatype engine does not support ${need.flag}; update it (\`supatype update\`, or pin versions.engine to a newer release)${byHand}`
}

/** Throw `OwnershipUnsupportedError` for the first need `caps` does not cover. */
export function assertSupported(caps: Capabilities, needs: readonly FeatureNeed[]): void {
  for (const need of needs) {
    const refusal = capabilityRefusal(need, caps)
    if (refusal !== undefined) throw new OwnershipUnsupportedError(refusal, need)
  }
}

/** The features in a `capabilities` answer, or undefined when it is not one. */
export function parseCapabilities(json: unknown): Set<string> | undefined {
  const features = (json as { features?: unknown } | null)?.features
  if (!Array.isArray(features)) return undefined
  return new Set(features.filter((f): f is string => typeof f === "string"))
}

/** What a binary that predates `capabilities` supports, from what `--version` printed. */
export function legacyFeatures(versionOutput: string): Set<string> {
  const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(versionOutput)?.[1]
  if (version === undefined || compareVersions(version, ENGINE_MIN_FOR_OWNERSHIP) < 0) return new Set()
  return new Set(LEGACY_OWNERSHIP_FEATURES)
}

/** Runs the engine with `args`; its exit and stdout. */
export type EngineProbe = (args: readonly string[]) => { status: number | null; stdout: string }

/**
 * What an engine supports, asking it with `probe`: `capabilities`, else `--version` for one from
 * before the subcommand. An engine that answers neither supports nothing.
 */
export function probeCapabilities(probe: EngineProbe): Capabilities {
  const answered = probe(["capabilities"])
  if (answered.status === 0) {
    const features = parseCapabilities(firstJson(answered.stdout))
    if (features !== undefined) return { features, source: "engine" }
  }
  const version = probe(["--version"])
  return { features: version.status === 0 ? legacyFeatures(version.stdout) : new Set(), source: "engine" }
}

/** The first JSON value in `text`, which may follow log lines. */
function firstJson(text: string): unknown {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

const binaryCache = new Map<string, Capabilities>()

/** What the engine binary at `bin` supports, asked once per process. */
export function binaryCapabilities(bin: string): Capabilities {
  const known = binaryCache.get(bin)
  if (known !== undefined) return known
  const caps = probeCapabilities((args) => {
    const run = spawnSync(bin, [...args], { encoding: "utf8" })
    return { status: run.status, stdout: run.stdout ?? "" }
  })
  binaryCache.set(bin, caps)
  return caps
}

/** What the engine this project runs locally supports: the binary `engineRequest` will spawn. */
export async function engineCapabilities(): Promise<Capabilities> {
  return binaryCapabilities(await engineBinPath())
}

/** Refuse, before anything is sent, a need the local engine binary does not support. */
export async function requireEngineFeatures(needs: readonly FeatureNeed[]): Promise<void> {
  if (needs.length === 0) return
  assertSupported(await engineCapabilities(), needs)
}
