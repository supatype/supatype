/**
 * The platform settings in `supatype.config.ts` that go beyond the schema, and what each becomes:
 *
 * - `services: { storage?: boolean, graphql?: boolean }`: `false` switches that service off. Self-host
 *   renders `SUPATYPE_STORAGE_DISABLED` / `SUPATYPE_GRAPHQL_DISABLED` into the server; a Cloud push
 *   sends it for the project's tenant config, which the server reads as the same switch.
 * - `realtime.channels` and `realtime.recheckSeconds`: self-host renders `REALTIME_CHANNELS` and
 *   `REALTIME_CHANNEL_RECHECK_S` as the realtime service's defaults (a value in `.env` wins); a Cloud
 *   push sets them on the project's realtime pod.
 * - `storage.s3`: the project's own S3 bucket on Cloud, with `env("NAME")` for its keys. Self-host
 *   takes its bucket from `S3_*` in `.env` as it always has, so this key changes nothing there.
 *
 * A key left out says nothing: the server's own default stands and nothing is sent for it.
 */
import { isJsonObject } from "@supatype/shared"
import { envReferenceName, validateHttpUrl, type EnvReference } from "./auth-providers.js"
import { objectAt } from "./ast-read.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** `services` in the project config. */
export interface ServicesConfig {
  /** `false` switches storage off: `/storage/v1` answers 503. Absent or `true` leaves it on. */
  storage?: boolean
  /** `false` switches GraphQL off: `/graphql/v1` answers 501. Absent or `true` leaves it on. */
  graphql?: boolean
}

/**
 * `storage.s3` in the project config: where a Cloud project keeps its files instead of the
 * platform's bucket. Switching buckets does not move existing files.
 */
export interface StorageS3Config {
  bucket: string
  /** AWS region. Required unless `endpoint` is set. */
  region?: string
  /** An S3-compatible store's https URL (R2, MinIO, B2). Absent for AWS. */
  endpoint?: string
  /** Path-style addressing. Left unset, it follows the endpoint (on with one, off without). */
  forcePathStyle?: boolean
  /** The access key id, as `env("NAME")`: the config is committed. */
  accessKey: EnvReference
  /** The secret access key, as `env("NAME")`. */
  secretKey: EnvReference
}

const SERVICE_NAMES = ["storage", "graphql"] as const
const S3_FIELDS = ["bucket", "region", "endpoint", "forcePathStyle", "accessKey", "secretKey"] as const
const MAX_RECHECK_SECONDS = 86_400

function validateServices(cfg: Readonly<Record<string, unknown>>, filename: string): void {
  const services = cfg["services"]
  if (services === undefined) return
  if (!isJsonObject(services)) throw new Error(`${filename}: services must be an object, as in { storage: false }`)
  for (const key of Object.keys(services)) {
    if (!(SERVICE_NAMES as readonly string[]).includes(key)) {
      throw new Error(`${filename}: services.${key} is not a service that can be switched (storage or graphql)`)
    }
  }
  for (const name of SERVICE_NAMES) {
    const value = services[name]
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${filename}: services.${name} must be true or false, got ${JSON.stringify(value)}`)
    }
  }
}

function validateRecheck(cfg: Readonly<Record<string, unknown>>, filename: string): void {
  const value = objectAt(cfg, "realtime")?.["recheckSeconds"]
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RECHECK_SECONDS) {
    throw new Error(`${filename}: realtime.recheckSeconds must be a whole number of seconds from 1 to ${MAX_RECHECK_SECONDS}, got ${JSON.stringify(value)}`)
  }
}

function requireString(value: unknown, path: string, filename: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${filename}: ${path} must be a non-empty string`)
  return value
}

/** A key as `env("NAME")` only: the config is committed, so a literal key would be published with it. */
function requireEnvKey(value: unknown, path: string, filename: string): void {
  if (typeof value === "string" && envReferenceName(value) !== undefined) return
  throw new Error(
    `${filename}: ${path} must name an environment variable, not hold the key: ${path.split(".").pop()}: env("S3_${path.endsWith("accessKey") ? "ACCESS" : "SECRET"}_KEY"), ` +
      "with the value in .env or the shell. The config is committed.",
  )
}

function validateStorageS3(cfg: Readonly<Record<string, unknown>>, filename: string): void {
  const storage = objectAt(cfg, "storage")
  const s3 = storage?.["s3"]
  if (s3 === undefined) return
  if (!isJsonObject(s3)) throw new Error(`${filename}: storage.s3 must be an object with a bucket, accessKey and secretKey`)
  for (const key of Object.keys(s3)) {
    if (!(S3_FIELDS as readonly string[]).includes(key)) throw new Error(`${filename}: storage.s3.${key} is not a setting (${S3_FIELDS.join(", ")})`)
  }
  if (storage?.["production"] !== "s3") {
    throw new Error(`${filename}: storage.s3 needs storage.production set to "s3", which is what says the project keeps its files in its own bucket`)
  }
  requireString(s3["bucket"], "storage.s3.bucket", filename)
  const endpoint = s3["endpoint"]
  if (endpoint !== undefined) {
    validateHttpUrl(requireString(endpoint, "storage.s3.endpoint", filename), "storage.s3.endpoint", filename)
  }
  if (s3["region"] !== undefined) requireString(s3["region"], "storage.s3.region", filename)
  if (s3["region"] === undefined && endpoint === undefined) {
    throw new Error(`${filename}: storage.s3.region is required for AWS S3; set storage.s3.endpoint instead for another S3-compatible store`)
  }
  if (s3["forcePathStyle"] !== undefined && typeof s3["forcePathStyle"] !== "boolean") {
    throw new Error(`${filename}: storage.s3.forcePathStyle must be true or false`)
  }
  requireEnvKey(s3["accessKey"], "storage.s3.accessKey", filename)
  requireEnvKey(s3["secretKey"], "storage.s3.secretKey", filename)
}

/** The checks for `services`, `realtime.recheckSeconds` and `storage.s3`, refused when the config is read. */
export function validatePlatformSettings(cfg: Readonly<Record<string, unknown>>, filename: string): void {
  validateServices(cfg, filename)
  validateRecheck(cfg, filename)
  validateStorageS3(cfg, filename)
}

/**
 * What the server is told about `services`: `SUPATYPE_STORAGE_DISABLED` and `SUPATYPE_GRAPHQL_DISABLED`
 * set to `true` for a service switched off, nothing otherwise, so the server's own default (on)
 * applies and a config that never mentions them renders as it did.
 */
export function serviceSwitchServerEnv(cfg: SupatypeProjectConfig): Record<string, string> {
  return {
    ...(cfg.services?.storage === false && { SUPATYPE_STORAGE_DISABLED: "true" }),
    ...(cfg.services?.graphql === false && { SUPATYPE_GRAPHQL_DISABLED: "true" }),
  }
}

/**
 * The realtime service's defaults from the config, for the compose file: `REALTIME_CHANNELS` when
 * `realtime.channels` is `"declared"` (`"open"` is the service's own default, and its variable
 * cannot loosen anything), and `REALTIME_CHANNEL_RECHECK_S`. Empty for a config that sets neither.
 */
export function realtimeServiceDefaults(cfg: SupatypeProjectConfig): { REALTIME_CHANNELS?: string; REALTIME_CHANNEL_RECHECK_S?: string } {
  const { channels, recheckSeconds } = cfg.realtime ?? {}
  return {
    ...(channels === "declared" && { REALTIME_CHANNELS: "declared" }),
    ...(recheckSeconds !== undefined && { REALTIME_CHANNEL_RECHECK_S: String(recheckSeconds) }),
  }
}

/** What `PUT /projects/:ref/platform-settings` takes: the switches and realtime options, whole. */
export interface PlatformSettingsBody {
  services: ServicesConfig
  realtime: { channels?: "open" | "declared"; recheckSeconds?: number }
}

/** The settings to send to a Cloud project, or undefined when the config sets none of them. */
export function platformSettingsBody(cfg: SupatypeProjectConfig): PlatformSettingsBody | undefined {
  const { storage, graphql } = cfg.services ?? {}
  const { channels, recheckSeconds } = cfg.realtime ?? {}
  const services: ServicesConfig = {
    ...(storage !== undefined && { storage }),
    ...(graphql !== undefined && { graphql }),
  }
  const realtime: PlatformSettingsBody["realtime"] = {
    ...(channels !== undefined && { channels }),
    ...(recheckSeconds !== undefined && { recheckSeconds }),
  }
  if (Object.keys(services).length === 0 && Object.keys(realtime).length === 0) return undefined
  return { services, realtime }
}

/** What `PUT /projects/:ref/storage-bucket` takes. */
export interface StorageBucketBody {
  bucket: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
  accessKey: string
  secretKey: string
}

export type StorageBucketPlan =
  | { kind: "none" }
  | { kind: "missing"; names: string[] }
  | { kind: "send"; body: StorageBucketBody }

/**
 * The bucket to send to a Cloud project, its keys read from `environment` (the shell over `.env`).
 * A key this machine does not have is named, not sent empty: the push says what to set.
 */
export function storageBucketPlan(cfg: SupatypeProjectConfig, environment: Readonly<Record<string, string | undefined>>): StorageBucketPlan {
  const s3 = cfg.storage?.s3
  if (s3 === undefined) return { kind: "none" }
  const names = [envReferenceName(s3.accessKey), envReferenceName(s3.secretKey)].filter((name): name is string => name !== undefined)
  const [accessKey, secretKey] = names.map((name) => environment[name])
  if (accessKey === undefined || accessKey === "" || secretKey === undefined || secretKey === "") {
    return { kind: "missing", names: names.filter((name) => (environment[name] ?? "") === "") }
  }
  const { bucket, region, endpoint, forcePathStyle } = s3
  return {
    kind: "send",
    body: {
      bucket,
      accessKey,
      secretKey,
      ...(region !== undefined && { region }),
      ...(endpoint !== undefined && { endpoint }),
      ...(forcePathStyle !== undefined && { forcePathStyle }),
    },
  }
}
