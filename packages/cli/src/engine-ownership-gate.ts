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
 *   means a server from before this check, which supports none of them. A project the server does
 *   not know is said as that, never as a server to update.
 * - The engine binary answers `supatype-engine capabilities`. One from before the subcommand is
 *   judged by its version: the ledger's first release had the flags listed in
 *   `LEGACY_OWNERSHIP_FEATURES`, and nothing older had any. An engine that answers neither never
 *   ran (an image Docker could not pull, a binary that is not there), which is an error, not an
 *   engine that supports nothing.
 *
 * Only an answer is remembered: a failed probe is asked again. A binary's answer is keyed on the
 * file (path, size, modified time) and a docker engine's on its image ID, so an engine swapped
 * under a long `dev` session is noticed at once and nothing else is asked twice. A server's answer
 * has nothing like that to key on, so it is trusted for `CAPABILITIES_TTL_MS`.
 *
 * Always the binary that will run (an override, a cached release offline), never the CDN's latest.
 */
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
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
  // A rebaseline told which drifted objects its preview showed, refusing if the drift has moved.
  "rebaseline_keys",
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
 * What a rebaseline needs to record only the drift its preview showed. An engine or server without
 * it records whatever drift there is when it runs, including drift that appeared after the person
 * looked (C04), so the CLI refuses rather than send a rebaseline unkeyed.
 */
export const REBASELINE_KEYS_NEED: FeatureNeed = {
  feature: "rebaseline_keys",
  flag: "--rebaseline (recording only the drift the preview showed)",
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

/** Runs the engine with `args`; its exit, stdout, and what else it printed. */
export type EngineProbe = (args: readonly string[]) => { status: number | null; stdout: string; stderr?: string }

/** The engine could not be asked: it never ran. Its output says why (an image pull, a missing binary). */
export class EngineProbeFailed extends Error {
  override readonly name = "EngineProbeFailed"
}

/**
 * What an engine supports, asking it with `probe`: `capabilities`, else `--version` for one from
 * before the subcommand. Throws {@link EngineProbeFailed} when it answers neither.
 */
export function probeCapabilities(probe: EngineProbe): Capabilities {
  const answered = probe(["capabilities"])
  if (answered.status === 0) {
    const features = parseCapabilities(firstJson(answered.stdout))
    if (features !== undefined) return { features, source: "engine" }
  }
  const version = probe(["--version"])
  if (version.status === 0) return { features: legacyFeatures(version.stdout), source: "engine" }
  const said = [version.stderr, answered.stderr].find((s) => s !== undefined && s.trim() !== "")?.trim()
  throw new EngineProbeFailed(`Could not ask the Supatype engine what it supports: ${said ?? "it did not run"}`)
}

/** How long a server's answer is trusted before it is asked again. */
export const CAPABILITIES_TTL_MS = 5 * 60_000

/**
 * Answers by key (a binary, a project and image, a server), each with when it was given. With
 * `ttlMs`, an answer older than that is asked again; without, the key itself changes when the
 * engine does.
 */
export interface CapabilitiesCache {
  answers: Map<string, { caps: Capabilities; at: number }>
  ttlMs?: number
}

/** A cache of answers, trusted for `ttlMs` when given. */
export function capabilitiesCache(ttlMs?: number): CapabilitiesCache {
  return { answers: new Map(), ...(ttlMs !== undefined && { ttlMs }) }
}

function recalled(cache: CapabilitiesCache, key: string): Capabilities | undefined {
  const known = cache.answers.get(key)
  if (known === undefined) return undefined
  if (cache.ttlMs === undefined || Date.now() - known.at <= cache.ttlMs) return known.caps
  cache.answers.delete(key)
  return undefined
}

function remember(cache: CapabilitiesCache, key: string, caps: Capabilities): Capabilities {
  cache.answers.set(key, { caps, at: Date.now() })
  return caps
}

/** The answer for `key`, asked with `probe` unless one is known. A throw is not remembered. */
export function rememberCapabilitiesSync(cache: CapabilitiesCache, key: string, probe: () => Capabilities): Capabilities {
  return recalled(cache, key) ?? remember(cache, key, probe())
}

/** {@link rememberCapabilitiesSync} for a probe that has to wait, such as a request to a server. */
export async function rememberCapabilities(
  cache: CapabilitiesCache,
  key: string,
  probe: () => Promise<Capabilities>,
): Promise<Capabilities> {
  return recalled(cache, key) ?? remember(cache, key, await probe())
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

const binaryCache = capabilitiesCache()

/** The binary as a cache key: a new file at the same path (an update, a rebuild) is a new key. */
function binaryKey(bin: string): string {
  try {
    const { size, mtimeMs } = statSync(bin)
    return `${bin}\0${size}\0${mtimeMs}`
  } catch {
    // Not there: the probe says so, and nothing is remembered.
    return bin
  }
}

/** What the engine binary at `bin` supports. */
export function binaryCapabilities(bin: string): Capabilities {
  return rememberCapabilitiesSync(binaryCache, binaryKey(bin), () =>
    probeCapabilities((args) => {
      const run = spawnSync(bin, [...args], { encoding: "utf8" })
      return { status: run.status, stdout: run.stdout ?? "", stderr: run.error?.message ?? run.stderr ?? "" }
    }),
  )
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
