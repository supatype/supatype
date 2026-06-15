import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ComponentVersions } from "./components.js"

// ---------------------------------------------------------------------------
// Config schema (single canonical shape; loaded from supatype.config.ts)
// ---------------------------------------------------------------------------

export interface SupatypeProjectConfig {
  /**
   * Runtime stack for local dev and `supatype update`.
   * "native" = host binaries (default). "docker" = self-host Compose stack.
   * Falls back to `database.provider` when omitted (deprecated).
   */
  provider?: "native" | "docker"
  supatype?: {
    /**
     * Base directory for Supatype project assets (schema, functions, etc).
     * "." means the current working directory (default).
     */
    root?: string
  }
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
     * Defaults to supatype/postgres:latest.
     * Override in supatype.local.config.ts for local builds.
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
    /** Port PostgREST listens on in local dev (default: 3001). */
    postgrestPort?: number
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
    /**
     * Vite dev server base URL for HMR (`/_vite/*`) when `server.mode` is dev.
     * Example: `http://127.0.0.1:5173`. Sets `SUPATYPE_VITE_DEV_URL` for supatype-server.
     * When omitted, dev still falls back to `SUPATYPE_APP_UPSTREAM` for non-proxy app modes.
     */
    vite_dev_url?: string
    /**
     * package.json script name for `supatype dev` to run when mode is proxy.
     * Default: `"start"`. Ignored for static/none modes.
     */
    start?: string
  }
  /**
   * Pinned binary versions per component. Use **`"local"`** with the matching **`overrides.*`**
   * entry when testing a local build (Phase 10.7).
   */
  versions: ComponentVersions
  /**
   * Override component binaries with local build paths.
   * Intended for supatype contributors testing local changes.
   * Cannot be combined with a linked cloud project (`project.ref`, `.supatype/cloud.json`, or `.supatype/linked.json`; hard error in `resolveBinary`).
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
     * "smtp"    = SMTP (set `smtp` below and/or GOTRUE_SMTP_* in `.env`)
     * "resend"  = Resend API (requires RESEND_API_KEY, RESEND_FROM)
     * "ses"     = AWS SES v2 (ambient credentials, requires SES_FROM)
     */
    provider: "console" | "smtp" | "resend" | "ses"
    /**
     * SMTP settings for provider=smtp (merged into process env as GOTRUE_SMTP_*).
     * Omitted keys can still be set via `.env` / shell.
     */
    smtp?: {
      host?: string
      port?: number
      user?: string
      pass?: string
      admin_email?: string
      sender_name?: string
    }
    /** Resend API key (provider=resend, or set RESEND_API_KEY env var). */
    resend_api_key?: string
    /** From address for Resend (provider=resend, or set RESEND_FROM env var). */
    resend_from?: string
    /** From address for SES (provider=ses, or set SES_FROM env var). */
    ses_from?: string
    /**
     * When true, `supatype dev` enables the GoTrue send-email HTTP hook pointing at this
     * server's POST `/internal/v0hooks/send-email` (signed delivery, dev-only secret).
     * Override `GOTRUE_HOOK_SEND_EMAIL_*` in `.env` if needed.
     */
    send_email_hook?: boolean
    /**
     * Override hook target URL when `send_email_hook` is true (e.g. HTTPS tunnel or Edge URL).
     * Default: `http://127.0.0.1:<serverPort>/internal/v0hooks/send-email`.
     */
    send_email_hook_uri?: string
    /**
     * Standard Webhooks v1 secrets for the send-email hook (`v1,whsec_...`, pipe-separated for rotation).
     * Default in dev: a fixed local secret; override for team-shared dev or CI.
     */
    send_email_hook_secrets?: string
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
  functions?: {
    /** Path to edge functions directory, relative to `supatype.root` when not absolute. */
    path?: string
  }
  output?: {
    /** Path for generated TypeScript types. */
    types?: string
    /** Path for generated client helpers. */
    client?: string
  }
  /**
   * App build configuration for `supatype deploy`.
   * Separate from `app` which controls how supatype-server serves at runtime.
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
  /**
   * Optional Postgres URL for CLI commands that talk to the DB (`push`, `migrate`, …).
   * When omitted, `DATABASE_URL` from the environment is used, then a local default DSN.
   */
  connection?: string
  /** Studio admin panel access (Gap Appendices task 47). */
  admin?: {
    /** JWT `app_metadata.role` values allowed to use Studio. Default: admin, supatype_admin */
    roles?: string[]
  }
}

// ---------------------------------------------------------------------------
// Merge + validate
// ---------------------------------------------------------------------------

/**
 * Merge each top-level section from `override` on top of `base`.
 * Within each section, override values win. New optional sections in override are added.
 */
export function mergeProjectConfig(
  base: SupatypeProjectConfig,
  override: Partial<SupatypeProjectConfig>,
): SupatypeProjectConfig {
  return {
    ...(base.provider !== undefined || override.provider !== undefined
      ? { provider: override.provider ?? base.provider }
      : {}),
    ...(base.supatype !== undefined || override.supatype !== undefined
      ? { supatype: { ...base.supatype, ...override.supatype } as NonNullable<SupatypeProjectConfig["supatype"]> }
      : {}),
    project: { ...base.project, ...override.project },
    database: { ...base.database, ...override.database },
    server: { ...base.server, ...override.server },
    app: { ...base.app, ...override.app },
    versions: { ...base.versions, ...override.versions },
    ...(base.overrides !== undefined || override.overrides !== undefined
      ? {
          overrides: {
            ...base.overrides,
            ...override.overrides,
          } as NonNullable<SupatypeProjectConfig["overrides"]>,
        }
      : {}),
    ...(base.email !== undefined || override.email !== undefined
      ? (() => {
          const b = base.email
          const o = override.email
          const mergedSmtp =
            b?.smtp !== undefined || o?.smtp !== undefined
              ? { ...(b?.smtp ?? {}), ...(o?.smtp ?? {}) }
              : undefined
          return {
            email: {
              ...b,
              ...o,
              ...(mergedSmtp !== undefined ? { smtp: mergedSmtp } : {}),
            } as NonNullable<SupatypeProjectConfig["email"]>,
          }
        })()
      : {}),
    ...(base.storage !== undefined || override.storage !== undefined
      ? {
          storage: {
            ...base.storage,
            ...override.storage,
          } as NonNullable<SupatypeProjectConfig["storage"]>,
        }
      : {}),
    ...(base.schema !== undefined || override.schema !== undefined
      ? { schema: { ...base.schema, ...override.schema } as NonNullable<SupatypeProjectConfig["schema"]> }
      : {}),
    ...(base.functions !== undefined || override.functions !== undefined
      ? { functions: { ...base.functions, ...override.functions } as NonNullable<SupatypeProjectConfig["functions"]> }
      : {}),
    ...(base.output !== undefined || override.output !== undefined
      ? { output: { ...base.output, ...override.output } as NonNullable<SupatypeProjectConfig["output"]> }
      : {}),
    ...(base.build !== undefined || override.build !== undefined
      ? { build: { ...base.build, ...override.build } as NonNullable<SupatypeProjectConfig["build"]> }
      : {}),
    ...(base.connection !== undefined || override.connection !== undefined
      ? { connection: override.connection ?? base.connection }
      : {}),
    ...(base.admin !== undefined || override.admin !== undefined
      ? { admin: { ...base.admin, ...override.admin } as NonNullable<SupatypeProjectConfig["admin"]> }
      : {}),
  }
}

export function validateProjectConfig(raw: unknown, filename: string): SupatypeProjectConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filename}: expected a config object at the root`)
  }

  const cfg = raw as Record<string, unknown>

  if (!cfg["project"] || typeof (cfg["project"] as Record<string, unknown>)["name"] !== "string") {
    throw new Error(`${filename}: project.name is required`)
  }
  if (!cfg["database"]) {
    throw new Error(`${filename}: database section is required`)
  }
  if (!cfg["server"]) {
    throw new Error(`${filename}: server section is required`)
  }
  if (!cfg["app"]) {
    throw new Error(`${filename}: app section is required`)
  }
  if (!cfg["versions"]) {
    throw new Error(`${filename}: versions section is required`)
  }

  return raw as SupatypeProjectConfig
}

/** Schema entry path (with fallback). */
export function schemaPathFromProject(cfg: SupatypeProjectConfig, cwd: string): string {
  return resolve(projectRootFromConfig(cfg, cwd), cfg.schema?.path ?? "schema/index.ts")
}

/** Resolve project root for schema/functions defaults. */
export function projectRootFromConfig(cfg: SupatypeProjectConfig, cwd: string): string {
  return resolve(cwd, cfg.supatype?.root ?? ".")
}

/** Candidate functions directories in lookup order. */
export function functionsPathCandidatesFromProject(cfg: SupatypeProjectConfig, cwd: string): string[] {
  const root = projectRootFromConfig(cfg, cwd)
  if (cfg.functions?.path) {
    return [resolve(root, cfg.functions.path)]
  }
  // Prefer modern default, but keep legacy fallback for compatibility.
  return [resolve(root, "functions"), resolve(root, "supatype/functions")]
}

/** Preferred default functions path (used when creating new functions). */
export function preferredFunctionsPathFromProject(cfg: SupatypeProjectConfig, cwd: string): string {
  const candidates = functionsPathCandidatesFromProject(cfg, cwd)
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0] ?? resolve(projectRootFromConfig(cfg, cwd), "functions")
}

/**
 * Derive the supatype-server base URL from the project config.
 * Returns undefined if the mode is "managed" (cloud controls the URL).
 */
export function serverBaseUrl(cfg: SupatypeProjectConfig): string | undefined {
  const port = cfg.server.port ?? 54321
  switch (cfg.server.mode) {
    case "dev":
    case "standalone":
      if (cfg.server.mode === "dev" && resolveRuntimeProvider(cfg) === "docker") {
        return `http://localhost:${COMPOSE_DEV_KONG_PORT}`
      }
      return cfg.server.domain
        ? `https://${cfg.server.domain}`
        : `http://localhost:${port}`
    case "managed":
      return undefined
  }
}

/** Resolved runtime provider (`config.provider` ?? `database.provider` ?? native). */
export function resolveRuntimeProvider(cfg: SupatypeProjectConfig): "native" | "docker" {
  return cfg.provider ?? cfg.database.provider ?? "native"
}

/** Kong gateway port when `provider: docker` (self-host compose dev). */
export const COMPOSE_DEV_KONG_PORT = 18473

/** The local Postgres DSN derived from project name (dev default). */
export function localDSN(cfg: SupatypeProjectConfig): string {
  const port = 5432 // standard; per-project state dir isolates data dirs
  return `postgres://postgres:postgres@127.0.0.1:${port}/${cfg.project.name}?sslmode=disable`
}

/**
 * Resolve the database connection string.
 * Prefers optional `connection` in config, then `DATABASE_URL` env, then a local default DSN.
 */
export function connectionString(cfg: SupatypeProjectConfig): string {
  return cfg.connection ?? process.env["DATABASE_URL"] ?? localDSN(cfg)
}
