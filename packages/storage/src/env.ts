/** Read an env var, falling back to a default. Throws if required and missing. */
function env(key: string, fallback?: string): string {
  const val = process.env[key]
  if (val !== undefined) return val
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${key}`)
}

export const config = {
  /** Postgres connection string for the storage metadata tables. */
  databaseUrl: env(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/postgres",
  ),

  /** JWT secret shared with GoTrue / Kong. */
  jwtSecret: env(
    "JWT_SECRET",
    "super-secret-jwt-token-change-in-production",
  ),

  /** S3-compatible endpoint (MinIO for local dev). */
  s3Endpoint: env("S3_ENDPOINT", "http://localhost:9000"),

  /** S3 region. */
  s3Region: env("S3_REGION", "us-east-1"),

  /** S3 access key. */
  s3AccessKey: env("S3_ACCESS_KEY", "supatype"),

  /** S3 secret key. */
  s3SecretKey: env("S3_SECRET_KEY", "supatype-secret"),

  /** Whether to force path-style access (required for MinIO). */
  s3ForcePathStyle: env("S3_FORCE_PATH_STYLE", "true") === "true",

  /** Maximum upload size in bytes (default 50 MB). */
  maxUploadSize: parseInt(env("MAX_UPLOAD_SIZE", String(50 * 1024 * 1024)), 10),

  /** Transform cache TTL in seconds (default 1 hour). */
  transformCacheTtl: parseInt(env("TRANSFORM_CACHE_TTL", "3600"), 10),

  /** Project tier — injected at deploy time for per-file and quota enforcement. */
  projectTier: env("PROJECT_TIER", "free") as "free" | "pro" | "team" | "enterprise",

  /** Per-file upload limit for the current tier (bytes). Overrides maxUploadSize when set. -1 = unlimited. */
  tierMaxUploadSize: parseInt(env("TIER_MAX_UPLOAD_SIZE", String(50 * 1024 * 1024)), 10),

  /** Total storage quota for this project (bytes). -1 = unlimited. */
  storageQuota: parseInt(env("STORAGE_QUOTA", String(1024 * 1024 * 1024)), 10),

  /** HMAC secret for pre-signed URL tokens. Falls back to JWT secret. */
  signedUrlSecret: env("SIGNED_URL_SECRET", env("JWT_SECRET", "super-secret-jwt-token-change-in-production")),

  /** Default pre-signed URL expiry in seconds. */
  defaultSignedUrlExpiry: parseInt(env("DEFAULT_SIGNED_URL_EXPIRY", "3600"), 10),

  /** Maximum pre-signed URL expiry in seconds (7 days). */
  maxSignedUrlExpiry: parseInt(env("MAX_SIGNED_URL_EXPIRY", "604800"), 10),
} as const
