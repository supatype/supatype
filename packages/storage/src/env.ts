/** Read an env var, falling back to a default. Throws if required and missing. */
function env(key: string, fallback?: string): string {
  const val = process.env[key]
  if (val !== undefined) return val
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${key}`)
}

const PROJECT_TIERS = ["free", "pro", "team", "enterprise"] as const

/**
 * `PROJECT_TIER`, refused at start when it is not a tier. A misspelt one used to be read as a tier
 * with no limits: no entry in the per-tier tables, so no quota at all.
 */
function projectTier(): (typeof PROJECT_TIERS)[number] {
  const raw = env("PROJECT_TIER", "free")
  const tier = PROJECT_TIERS.find((known) => known === raw)
  if (tier === undefined) throw new Error(`PROJECT_TIER must be one of ${PROJECT_TIERS.join(", ")}, got "${raw}"`)
  return tier
}

/**
 * A byte limit read from the environment, refused at start when it is not a whole number. -1 is
 * unlimited. Unset is `undefined`, so the limit falls to the tier's own: a deployment that sets
 * nothing gets its tier's limits, and one that sets -1 gets none.
 */
function byteLimit(key: string): number | undefined {
  const raw = process.env[key]
  if (raw === undefined) return undefined
  const bytes = Number(raw)
  if (raw.trim() === "" || !Number.isInteger(bytes) || bytes < -1) {
    throw new Error(`${key} must be a whole number of bytes, or -1 for unlimited, got "${raw}"`)
  }
  return bytes
}

export const config = {
  /** Postgres connection string for the storage metadata tables. */
  databaseUrl: env(
    "DATABASE_URL",
    "postgresql://supatype_admin:postgres@localhost:5432/postgres",
  ),

  /**
   * JWT secret shared with the auth service and Kong.
   *
   * **No fallback, deliberately.** This validates every caller's token, and the value it used
   * to default to is published in this repository, so a deployment that forgot to set
   * JWT_SECRET accepted tokens anyone could mint, and looked healthy doing it. Refusing to
   * start is the only safe reading of a missing signing secret.
   */
  jwtSecret: env("JWT_SECRET"),

  /** S3-compatible endpoint (SeaweedFS for local dev). */
  s3Endpoint: env("S3_ENDPOINT", "http://localhost:8333"),

  /** S3 region. */
  s3Region: env("S3_REGION", "us-east-1"),

  /** S3 access key. */
  s3AccessKey: env("S3_ACCESS_KEY", "supatype"),

  /** S3 secret key. */
  s3SecretKey: env("S3_SECRET_KEY", "supatype-secret"),

  /** Whether to force path-style access (required for SeaweedFS). */
  s3ForcePathStyle: env("S3_FORCE_PATH_STYLE", "true") === "true",

  /**
   * Publicly reachable base URL for S3 objects in public buckets.
   * For SeaweedFS in local dev this is the same as S3_ENDPOINT (e.g. http://localhost:8333).
   * For AWS set this to your CloudFront domain or the bucket's public S3 URL.
   * Defaults to S3_ENDPOINT.
   */
  s3PublicUrl: env("S3_PUBLIC_URL", env("S3_ENDPOINT", "http://localhost:8333")),

  /** Per-file ceiling (bytes) when the tier sets none (default 50 MB). -1 = unlimited. */
  maxUploadSize: byteLimit("MAX_UPLOAD_SIZE") ?? 50 * 1024 * 1024,

  /** Transform cache TTL in seconds (default 1 hour). */
  transformCacheTtl: parseInt(env("TRANSFORM_CACHE_TTL", "3600"), 10),

  /** Project tier: injected at deploy time for per-file and quota enforcement. */
  projectTier: projectTier(),

  /** Per-file upload limit (bytes). Unset = the tier's. -1 = none, leaving maxUploadSize. */
  tierMaxUploadSize: byteLimit("TIER_MAX_UPLOAD_SIZE"),

  /** Total storage quota for this project (bytes). Unset = the tier's. -1 = unlimited. */
  storageQuota: byteLimit("STORAGE_QUOTA"),

  /** HMAC secret for pre-signed URL tokens. Falls back to the JWT secret, which is required. */
  signedUrlSecret: env("SIGNED_URL_SECRET", env("JWT_SECRET")),

  /** Default pre-signed URL expiry in seconds. */
  defaultSignedUrlExpiry: parseInt(env("DEFAULT_SIGNED_URL_EXPIRY", "3600"), 10),

  /** Maximum pre-signed URL expiry in seconds (7 days). */
  maxSignedUrlExpiry: parseInt(env("MAX_SIGNED_URL_EXPIRY", "604800"), 10),
} as const
