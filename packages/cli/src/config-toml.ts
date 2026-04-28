import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import TOML from "@iarna/toml"

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export interface SupatypeTomlConfig {
  project: {
    /** Project name — used for per-project state dirs and logging. */
    name: string
    /** Cloud project reference (set by `supatype link`). */
    ref?: string
  }
  database: {
    /**
     * Database backend.
     * "native" = supatype manages a native Postgres binary (downloaded from CDN).
     * "docker" = supatype runs supatype/postgres via Docker (includes all extensions).
     */
    provider: "native" | "docker"
    /**
     * Directory where Postgres stores its data files (provider=native).
     * Defaults to ~/.supatype/projects/{name}/data when omitted.
     */
    data_dir?: string
    /**
     * Docker image to use (provider=docker).
     * Defaults to supatype/postgres:17-latest.
     * Override in supatype.local.config.toml to use a locally-built image:
     *   image = "supatype/postgres:local"
     */
    image?: string
  }
  server: {
    /**
     * Server mode.
     * "dev"        = no TLS, permissive CORS, Vite HMR proxy
     * "standalone" = ACME TLS (Let's Encrypt)
     * "managed"    = cloud-managed, HMAC tenant verification
     */
    mode: "dev" | "standalone" | "managed"
    /** Port supatype-server listens on (default: 54321). */
    port?: number
    /** Domain for ACME TLS certificate (mode=standalone). */
    domain?: string
  }
  app: {
    /**
     * How the root path "/" is handled by supatype-server.
     * "none"   = 404
     * "static" = serve files from static_dir
     * "proxy"  = reverse-proxy to upstream
     */
    mode: "none" | "static" | "proxy"
    /** Directory to serve static files from (mode=static). */
    static_dir?: string
    /** Upstream URL to proxy to (mode=proxy). */
    upstream?: string
  }
  versions: {
    /** Supatype schema engine binary version (e.g. "0.4.2"). */
    engine: string
    /** supatype-server binary version (e.g. "0.1.0"). */
    server: string
    /** Native Postgres archive version (e.g. "17.2"). */
    postgres: string
    /** Deno binary version (e.g. "2.2.0"). */
    deno: string
  }
  /**
   * Override component binaries with local build paths.
   * Intended for supatype contributors testing local changes.
   * Cannot be combined with a linked cloud project (hard error).
   */
  overrides?: {
    /** Path to local engine binary. */
    engine?: string
    /** Path to local supatype-server binary. */
    server?: string
    /** Path to a directory containing a local Postgres installation. */
    postgres_dir?: string
    /** Path to a local deno binary. */
    deno?: string
    /** Path to the @supatype/studio package directory (starts Vite dev server). */
    studio?: string
    /** Path to a local PostgREST binary. */
    postgrest?: string
  }
  email?: {
    /**
     * Email delivery provider.
     * "console" = log to stdout (default for dev)
     * "smtp"    = SMTP via env SMTP_* vars
     * "resend"  = Resend API (requires RESEND_API_KEY, RESEND_FROM)
     * "ses"     = AWS SES v2 (ambient credentials, requires SES_FROM)
     */
    provider: "console" | "smtp" | "resend" | "ses"
    /** Resend API key (provider=resend, or set RESEND_API_KEY env var). */
    resend_api_key?: string
  }
  storage?: {
    /**
     * Storage backend.
     * "local" = files on disk (LocalStoragePath required)
     * "s3"    = AWS S3 or compatible (ambient credentials)
     */
    provider: "local" | "s3"
    /** Local directory to store objects in (provider=local). */
    local_path?: string
  }
  schema?: {
    /** Path (or glob) to the schema entry point. Defaults to "schema/index.ts". */
    path?: string
    /** Postgres schema name. Defaults to "public". */
    pg_schema?: string
  }
  output?: {
    /** Path for generated TypeScript types. */
    types?: string
    /** Path for generated client helpers. */
    client?: string
  }
  /**
   * App build configuration for `supatype deploy`.
   * Separate from [app] which controls how supatype-server serves at runtime.
   */
  build?: {
    /** Framework name. Auto-detected from package.json when omitted. */
    framework?: "nextjs" | "astro" | "vite" | "remix-spa" | "sveltekit" | "nuxt" | "static"
    /** Path to the app directory. Defaults to cwd. */
    directory?: string
    /** Build command. Inferred from framework when omitted. */
    buildCommand?: string
    /** Build output directory. Inferred from framework when omitted. */
    outputDirectory?: string
    /** Enable SPA fallback routing. */
    spa?: boolean
    /** Environment variables injected at build time. */
    env?: Record<string, string>
    /** Custom response headers for the deployed static site. */
    headers?: Record<string, string>
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const TOML_CANDIDATES = ["supatype.config.toml"]
const LOCAL_CONFIG_NAME = "supatype.local.config.toml"
const LEGACY_CANDIDATES = [
  "supatype.config.ts",
  "supatype.config.js",
  "supatype.config.mjs",
]

/**
 * Load and parse supatype.config.toml from cwd.
 *
 * If supatype.local.config.toml also exists, it is deep-merged on top of the
 * base config (local values take precedence, section by section). The local
 * file is gitignored and intended for [overrides] — local binary paths that
 * should never be committed.
 *
 * Throws if:
 * - No TOML config found but a legacy .ts config exists (migration notice).
 * - TOML is found but missing required fields.
 */
export function loadTomlConfig(cwd: string = process.cwd()): SupatypeTomlConfig {
  for (const candidate of TOML_CANDIDATES) {
    const configPath = resolve(cwd, candidate)
    if (!existsSync(configPath)) continue

    const raw = readFileSync(configPath, "utf8")
    let parsed: unknown
    try {
      parsed = TOML.parse(raw)
    } catch (err) {
      throw new Error(`Failed to parse ${candidate}: ${(err as Error).message}`)
    }

    const base = validateTomlConfig(parsed, candidate)

    // Merge supatype.local.config.toml if present.
    const localPath = resolve(cwd, LOCAL_CONFIG_NAME)
    if (existsSync(localPath)) {
      const localRaw = readFileSync(localPath, "utf8")
      let localParsed: unknown
      try {
        localParsed = TOML.parse(localRaw)
      } catch (err) {
        throw new Error(`Failed to parse ${LOCAL_CONFIG_NAME}: ${(err as Error).message}`)
      }
      return mergeConfigs(base, localParsed as Partial<SupatypeTomlConfig>)
    }

    return base
  }

  // Check for legacy .ts config and print migration notice.
  for (const candidate of LEGACY_CANDIDATES) {
    if (existsSync(resolve(cwd, candidate))) {
      throw new Error(
        `Found ${candidate} but supatype now uses supatype.config.toml.\n` +
          "Run: supatype init --migrate  to convert your config.\n" +
          "See: https://docs.supatype.io/migration/toml-config",
      )
    }
  }

  throw new Error(
    "No supatype.config.toml found in the current directory.\n" +
      "Run: supatype init",
  )
}

/**
 * Merge each top-level section from `override` on top of `base`.
 * Within each section, local values win. New optional sections in local are added.
 */
function mergeConfigs(
  base: SupatypeTomlConfig,
  override: Partial<SupatypeTomlConfig>,
): SupatypeTomlConfig {
  return {
    project:  { ...base.project,  ...override.project  },
    database: { ...base.database, ...override.database },
    server:   { ...base.server,   ...override.server   },
    app:      { ...base.app,      ...override.app      },
    versions: { ...base.versions, ...override.versions },
    ...(base.overrides !== undefined || override.overrides !== undefined
      ? { overrides: { ...base.overrides, ...override.overrides } as NonNullable<SupatypeTomlConfig["overrides"]> }
      : {}),
    ...(base.email !== undefined || override.email !== undefined
      ? { email: { ...base.email, ...override.email } as NonNullable<SupatypeTomlConfig["email"]> }
      : {}),
    ...(base.storage !== undefined || override.storage !== undefined
      ? { storage: { ...base.storage, ...override.storage } as NonNullable<SupatypeTomlConfig["storage"]> }
      : {}),
    ...(base.schema !== undefined || override.schema !== undefined
      ? { schema: { ...base.schema, ...override.schema } as NonNullable<SupatypeTomlConfig["schema"]> }
      : {}),
    ...(base.output !== undefined || override.output !== undefined
      ? { output: { ...base.output, ...override.output } as NonNullable<SupatypeTomlConfig["output"]> }
      : {}),
    ...(base.build !== undefined || override.build !== undefined
      ? { build: { ...base.build, ...override.build } as NonNullable<SupatypeTomlConfig["build"]> }
      : {}),
  }
}

function validateTomlConfig(raw: unknown, filename: string): SupatypeTomlConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filename}: expected a TOML object at the root`)
  }

  const cfg = raw as Record<string, unknown>

  if (!cfg["project"] || typeof (cfg["project"] as Record<string, unknown>)["name"] !== "string") {
    throw new Error(`${filename}: [project] name is required`)
  }
  if (!cfg["database"]) {
    throw new Error(`${filename}: [database] section is required`)
  }
  if (!cfg["server"]) {
    throw new Error(`${filename}: [server] section is required`)
  }
  if (!cfg["app"]) {
    throw new Error(`${filename}: [app] section is required`)
  }
  if (!cfg["versions"]) {
    throw new Error(`${filename}: [versions] section is required`)
  }

  return raw as SupatypeTomlConfig
}

/** The path to the schema entry point from a TOML config (with fallback). */
export function schemaPathFromToml(cfg: SupatypeTomlConfig, cwd: string): string {
  return resolve(cwd, cfg.schema?.path ?? "schema/index.ts")
}

/**
 * Derive the supatype-server base URL from the TOML config.
 * Returns undefined if the mode is "managed" (cloud controls the URL).
 */
export function serverBaseUrl(cfg: SupatypeTomlConfig): string | undefined {
  const port = cfg.server.port ?? 54321
  switch (cfg.server.mode) {
    case "dev":
    case "standalone":
      return cfg.server.domain
        ? `https://${cfg.server.domain}`
        : `http://localhost:${port}`
    case "managed":
      return undefined
  }
}

/** The local Postgres DSN derived from TOML config project name and port. */
export function localDSN(cfg: SupatypeTomlConfig): string {
  const port = 5432 // standard; per-project state dir isolates data dirs
  return `postgres://postgres:postgres@127.0.0.1:${port}/${cfg.project.name}`
}

/**
 * Resolve the database connection string for a TOML project.
 * Prefers DATABASE_URL env var, then derives from TOML config.
 */
export function connectionString(cfg: SupatypeTomlConfig): string {
  return process.env["DATABASE_URL"] ?? localDSN(cfg)
}
