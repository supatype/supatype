/**
 * A static site's public values: the non-secret settings its pages read, set per environment in
 * `build.publicEnv` of supatype.config.ts or in Studio, served at `/supatype-env.js` and passed to
 * the build under each framework's prefix. Every visitor can read them, so what may be one is
 * decided here, once, for the CLI, the self-host control plane and the checks Cloud repeats.
 */

/** Each framework's public prefix: Vite, SvelteKit and Astro (`PUBLIC_`), Next.js, Expo. */
export const FRONTEND_PUBLIC_PREFIXES = ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"] as const

/** Prefixes a name may not start with: a framework's, which the build adds itself, and Supatype's own. */
const RESERVED_PREFIXES: readonly string[] = [...FRONTEND_PUBLIC_PREFIXES, "SUPATYPE_"]

/** What a project may set. Bytes are UTF-8 bytes. */
export const PUBLIC_ENV_LIMITS = {
  /** Values a project may set. */
  names: 50,
  /** One name. */
  nameBytes: 64,
  /** One value. */
  valueBytes: 2048,
  /** Every name and value together. */
  totalBytes: 16384,
} as const

/** Upper-case letters, digits and underscores, starting with a letter: a name every framework and shell accepts. */
export const PUBLIC_ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/** `build.publicEnv`: a value for every environment, or a map of environment name to value. */
export type PublicEnvDeclaration = Readonly<Record<string, string | Readonly<Record<string, string>>>>

/** An environment name as Cloud accepts it. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether `value` is a `build.publicEnv`: each name one string, or a map of environment name to string. */
export function isPublicEnvDeclaration(value: unknown): value is PublicEnvDeclaration {
  if (!isObject(value)) return false
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (isObject(entry) && Object.entries(entry).every(([environment, text]) => ENVIRONMENT_NAME.test(environment) && typeof text === "string")),
  )
}

/** Where a value is set: the config's build.publicEnv (read-only in Studio), or Studio. */
export const PUBLIC_ENV_SOURCES = ["config", "studio"] as const
export type PublicEnvSource = (typeof PUBLIC_ENV_SOURCES)[number]

/** How each source is said to a person. */
export const PUBLIC_ENV_SOURCE_LABELS: Readonly<Record<PublicEnvSource, string>> = {
  config: "set in supatype.config.ts",
  studio: "set in Studio",
}

/** One value in effect on an environment, with where it is set. */
export interface PublicEnvEntry {
  name: string
  value: string
  source: PublicEnvSource
}

/** Whether `value` is a {@link PublicEnvEntry}. */
export function isPublicEnvEntry(value: unknown): value is PublicEnvEntry {
  if (!isObject(value)) return false
  return typeof value["name"] === "string" && typeof value["value"] === "string" && PUBLIC_ENV_SOURCES.some((source) => source === value["source"])
}

/** One refusal. `name` is the value's name, or empty for a problem with the set as a whole. */
export interface PublicEnvProblem {
  name: string
  reason: string
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
/** Stripe's secret and restricted keys: `sk_live_...`, `sk_test_...`, `rk_live_...`. */
const SECRET_KEY_PREFIX = /\b(?:sk|rk)_[A-Za-z0-9_]{6,}/

/** The role claim of a JWT, or undefined for anything that is not one. The signature is not checked. */
function jwtRole(value: string): string | undefined {
  const parts = value.split(".")
  if (parts.length !== 3 || parts[1] === undefined) return undefined
  try {
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    const claims: unknown = JSON.parse(payload)
    if (typeof claims !== "object" || claims === null || !("role" in claims)) return undefined
    return typeof claims.role === "string" ? claims.role : undefined
  } catch {
    return undefined
  }
}

/**
 * Why `value` looks like a secret, or undefined when it does not: a private key block, an `sk_` or
 * `rk_` key, a token claiming the service role, or one of `secrets` (a key the caller holds). The
 * reason never repeats the value.
 */
export function secretLookingReason(value: string, secrets: readonly string[] = []): string | undefined {
  if (PRIVATE_KEY_BLOCK.test(value)) return "looks like a private key"
  if (SECRET_KEY_PREFIX.test(value)) return "looks like a secret key (sk_ or rk_)"
  if (jwtRole(value) === "service_role") return "is a service role key"
  if (secrets.some((secret) => secret !== "" && secret === value)) return "is a secret this project holds"
  return undefined
}

function nameProblem(name: string): string | undefined {
  if (!PUBLIC_ENV_NAME.test(name)) return "must be upper case letters, digits and underscores, starting with a letter"
  if (bytesOf(name) > PUBLIC_ENV_LIMITS.nameBytes) return `must be at most ${PUBLIC_ENV_LIMITS.nameBytes} bytes`
  const reserved = RESERVED_PREFIXES.find((prefix) => name.startsWith(prefix))
  if (reserved !== undefined) return `must not start with ${reserved}: the build adds each framework's prefix itself, and SUPATYPE_ names are Supatype's own`
  return undefined
}

/**
 * Everything wrong with `values` as one environment's public values, each said once: a name that is
 * not allowed, a value over the limit or that looks secret, and a set over its limits. Empty when
 * `values` may be set. `secrets` are keys the caller holds that no value may equal.
 */
export function publicEnvProblems(values: Readonly<Record<string, string>>, secrets: readonly string[] = []): PublicEnvProblem[] {
  const problems: PublicEnvProblem[] = []
  const entries = Object.entries(values)
  for (const [name, value] of entries) {
    const bad = nameProblem(name)
    if (bad !== undefined) problems.push({ name, reason: bad })
    if (bytesOf(value) > PUBLIC_ENV_LIMITS.valueBytes) problems.push({ name, reason: `must be at most ${PUBLIC_ENV_LIMITS.valueBytes} bytes` })
    const secret = secretLookingReason(value, secrets)
    if (secret !== undefined) problems.push({ name, reason: `${secret}, and every visitor can read a public value` })
  }
  if (entries.length > PUBLIC_ENV_LIMITS.names) problems.push({ name: "", reason: `at most ${PUBLIC_ENV_LIMITS.names} values may be set` })
  const total = entries.reduce((sum, [name, value]) => sum + bytesOf(name) + bytesOf(value), 0)
  if (total > PUBLIC_ENV_LIMITS.totalBytes) problems.push({ name: "", reason: `the values may total at most ${PUBLIC_ENV_LIMITS.totalBytes} bytes` })
  return problems
}

/**
 * The values `declared` gives environment `environment`: a plain string for every environment, an
 * entry of a map for the one it names. A name whose map does not name the environment is left out.
 */
export function publicEnvFor(declared: PublicEnvDeclaration | undefined, environment: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(declared ?? {})) {
    if (typeof value === "string") values[name] = value
    else if (Object.hasOwn(value, environment)) values[name] = value[environment] as string
  }
  return values
}

/** Each value under every framework's prefix, the names a build reads: `MAPS_KEY` is `VITE_MAPS_KEY`, `NEXT_PUBLIC_MAPS_KEY` and so on. */
export function prefixedPublicEnv(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) => FRONTEND_PUBLIC_PREFIXES.map((prefix) => [`${prefix}${name}`, value] as const)),
  )
}

/**
 * The refusals as one message, naming each value and never repeating it. A problem with the set as
 * a whole has no name and is said as the public values'.
 */
export function publicEnvRefusal(problems: readonly PublicEnvProblem[], separator = "; "): string {
  return problems.map((p) => (p.name === "" ? `The public values: ${p.reason}` : `${p.name} ${p.reason}`)).join(separator)
}
