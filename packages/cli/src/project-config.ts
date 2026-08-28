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
    /** Project name: used for per-project state dirs and logging. */
    name: string
    /** Cloud project reference (set by `supatype link`). */
    ref?: string
  }
  database: {
    /**
     * Database backend.
     * "native" = supatype manages a native Postgres binary (downloaded from CDN).
     * "docker" = supatype runs supatype/postgres via Docker (includes all extensions).
     *
     * Omitted when `external` is set, there is no backend for Supatype to choose.
     */
    provider?: "native" | "docker"
    /**
     * Point the stack at a Postgres that already exists, instead of provisioning one.
     *
     * The presence of this block is the switch: with it, no `db` service is generated and every
     * service connects here. Deliberately not an overload of `connection`, which means something
     * narrower (a DSN for CLI commands) and would become the third setting meaning two things.
     *
     * **Self-host only.** On the cloud path the database is part of what is being provided, so the
     * block is rejected rather than ignored.
     */
    external?: {
      /**
       * Postgres URL for every service in the stack.
       *
       * The role in it owns the schema and runs migrations. PostgREST connects as `authenticator`
       * separately: see `supatype db check`, which reports what this database is missing.
       */
      url: string
      /**
       * Force realtime off.
       *
       * Realtime needs logical replication (`wal_level = logical`, a replication slot, and
       * `wal2json`), which a managed provider may not offer. Left unset, the stack probes for the
       * capability and records the answer, so this is only for overriding a probe that says yes when
       * you would rather it did not run.
       */
      realtime?: boolean
    }
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
    /**
     * TLS for self-host HTTPS (Kong ACME / Let's Encrypt).
     * Requires `mode: "standalone"` and a non-empty `domain`.
     */
    tls?: {
      /** ACME contact email for Let's Encrypt (required to enable HTTPS). */
      email?: string
      /** "kong" (default) = Kong acme plugin; "none" = stay HTTP even with a domain. */
      provider?: "kong" | "none"
    }
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
   * Optional pins for engine, server, postgres, and deno.
   * Omitted = resolve latest from CDN at runtime (native) or use Docker :latest.
   * When set, native binaries cache under ~/.supatype/cache/{component}/{version}/
   * and Docker image tags are synced to `.env` on `supatype dev` / `supatype push`.
   * Use **`"local"`** with the matching **`overrides.*`** entry for contributor builds.
   */
  versions?: Partial<ComponentVersions>
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
    /** Path to a local supatype-realtime binary (or node entry script). */
    realtime?: string
    /** Path to the @supatype/studio package directory (starts Vite dev server). */
    studio?: string
    /** Path to a local PostgREST binary. */
    postgrest?: string
  }
  email?: {
    /**
     * Email delivery provider.
     * "console" = log to stdout (default for dev)
     * "smtp"    = SMTP (set `smtp` below and/or SUPATYPE_SMTP_* in `.env`)
     * "resend"  = Resend API (requires RESEND_API_KEY, RESEND_FROM)
     * "ses"     = AWS SES v2 (ambient credentials, requires SES_FROM)
     */
    provider: "console" | "smtp" | "resend" | "ses"
    /**
     * SMTP settings for provider=smtp (merged into process env as SUPATYPE_SMTP_*).
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
     * When true, `supatype dev` enables the send-email HTTP hook pointing at this
     * server's POST `/internal/v0hooks/send-email` (signed delivery, dev-only secret).
     * Override `SUPATYPE_HOOK_SEND_EMAIL_*` in `.env` if needed.
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
    /**
     * Schemas the REST API exposes, in order (`PGRST_DB_SCHEMA`).
     *
     * Defaults to `pg_schema` plus the ones the stack needs for itself, `supatype` for Studio's
     * views, `graphql_public`, `auth`: so setting `pg_schema` alone does the sensible thing.
     *
     * It used to be a hardcoded literal, which meant choosing a non-`public` `pg_schema` gave you
     * a correct push and an API that answered `PGRST106` for everything: the engine had moved and
     * PostgREST had not been told. State this explicitly when you need a different set, an extra
     * schema of your own, or to stop exposing one.
     */
    api_schemas?: readonly string[]
  }
  functions?: {
    /** Path to edge functions directory, relative to `supatype.root` when not absolute. */
    path?: string
    /**
     * **Public functions** allowed to see the service-role key, which reads and writes past every
     * access rule.
     *
     * Empty by default, and that default is the point: a function is a public endpoint anyone holding
     * the anon key can invoke, so an ambient admin credential made every one of them able to read the
     * whole database. Naming one here is a reviewable line in a diff; ambient privilege is not.
     *
     * **Model hooks are not listed here and do not need to be.** A hook is procedural: only the API
     * server calls it, around a write the caller was already permitted to make, and the gateway
     * refuses its route from outside, so there is no attacker to withhold it from, and the trust is
     * the same a trigger already has.
     */
    serviceRole?: readonly string[]
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
   * Persistent environment defaults for `resolveTarget()` when `--env` is omitted.
   * Ephemeral schema branches (Phase 22) use `.supatype/branch.json`, not this block.
   */
  environments?: {
    default?: string
    branchDefaults?: Record<string, string>
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
    ...(base.versions !== undefined || override.versions !== undefined
      ? { versions: { ...base.versions, ...override.versions } }
      : {}),
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
    ...(base.environments !== undefined || override.environments !== undefined
      ? (() => {
          const b = base.environments
          const o = override.environments
          const mergedBranchDefaults =
            b?.branchDefaults !== undefined || o?.branchDefaults !== undefined
              ? { ...(b?.branchDefaults ?? {}), ...(o?.branchDefaults ?? {}) }
              : undefined
          return {
            environments: {
              ...b,
              ...o,
              ...(mergedBranchDefaults !== undefined ? { branchDefaults: mergedBranchDefaults } : {}),
            } as NonNullable<SupatypeProjectConfig["environments"]>,
          }
        })()
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

  validateExternalDatabase(cfg, filename)

  return raw as SupatypeProjectConfig
}

/**
 * Rules for `database.external`, all of them errors rather than precedence.
 *
 * Every one of these is a case where two settings describe the same fact and the stack would have to
 * pick. A silent winner is how you end up with a push that went somewhere other than where the
 * services are reading, which looks like data loss and is not.
 */
function validateExternalDatabase(cfg: Record<string, unknown>, filename: string): void {
  const database = cfg["database"] as Record<string, unknown>
  const external = database["external"]
  if (external === undefined) return

  if (typeof external !== "object" || external === null || Array.isArray(external)) {
    throw new Error(`${filename}: database.external must be an object with a url`)
  }

  const url = (external as Record<string, unknown>)["url"]
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error(
      `${filename}: database.external.url is required, the Postgres URL every service connects to.\n` +
        "Reading it from the environment keeps the password out of version control:\n" +
        "  database: { external: { url: process.env.DATABASE_URL! } }\n" +
        "The project's .env is loaded before the config module, so DATABASE_URL there is enough.",
    )
  }
  if (!/^postgres(ql)?:\/\//.test(url.trim())) {
    throw new Error(
      `${filename}: database.external.url must be a postgres:// or postgresql:// URL (got "${url.trim()}")`,
    )
  }

  const realtime = (external as Record<string, unknown>)["realtime"]
  if (realtime !== undefined && typeof realtime !== "boolean") {
    throw new Error(`${filename}: database.external.realtime must be true or false`)
  }

  if (database["provider"] !== undefined) {
    throw new Error(
      `${filename}: database.provider ("${String(database["provider"])}") and database.external ` +
        "cannot both be set, provider chooses a Postgres for Supatype to run, external says one " +
        "already exists.\n" +
        "Remove database.provider. The runtime stack is still chosen by the top-level `provider`.",
    )
  }

  const server = cfg["server"] as Record<string, unknown> | undefined
  if (server?.["mode"] === "managed") {
    throw new Error(
      `${filename}: database.external is not supported with server.mode "managed", on the cloud ` +
        "path the database is part of what is being provided.\n" +
        "Use an external database with a self-hosted stack (server.mode \"dev\" or \"standalone\").",
    )
  }

  const connection = cfg["connection"]
  if (typeof connection === "string" && connection.trim() !== url.trim()) {
    throw new Error(
      `${filename}: connection and database.external.url are both set and disagree.\n` +
        "database.external.url is what the whole stack uses, CLI commands included, remove " +
        "`connection`.",
    )
  }
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

/**
 * Directory holding **model hooks**, procedural handlers the API calls around a write.
 *
 * Separate from `functions/` because the two have different trust models: a function is a public
 * endpoint anyone with the anon key may invoke, while a hook is only ever called by the server. One
 * worker serves both, and the gateway refuses the hook namespace from outside, so keeping them in
 * separate directories is what makes that boundary structural rather than a list to maintain.
 */
export function hooksPathFromProject(cfg: SupatypeProjectConfig, cwd: string): string {
  const root = projectRootFromConfig(cfg, cwd)
  return resolve(root, "hooks")
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

/**
 * True when `supatype self-host compose` should render Kong ACME TLS (Let's Encrypt).
 * Gated on a real self-host render (not `supatype dev`), standalone mode, a non-empty
 * domain, an ACME contact email, and `tls.provider !== "none"`.
 */
export function selfHostTlsEnabled(
  cfg: SupatypeProjectConfig,
  devLocal = false,
): boolean {
  if (devLocal) return false
  if (cfg.server.mode !== "standalone") return false
  const domain = cfg.server.domain?.trim()
  if (!domain) return false
  const tls = cfg.server.tls
  if (!tls || tls.provider === "none") return false
  return Boolean(tls.email?.trim())
}

/** Resolved runtime provider (`config.provider` ?? `database.provider` ?? native). */
export function resolveRuntimeProvider(cfg: SupatypeProjectConfig): "native" | "docker" {
  return cfg.provider ?? cfg.database.provider ?? "native"
}

/**
 * Routes entitled to the service-role key, as the worker's env expects them.
 *
 * Resolved here rather than in the compose template so there is one definition of the format.
 *
 * This does **not** check that the names exist, it cannot, since it has only the config. An earlier
 * version of this comment claimed a typo was "visible in one place rather than silently granting
 * nothing", which was false: nothing read the list except the two callers that turn it into an env var.
 * `checkServiceRoleRoutes` in `service-role-check.ts` is what actually resolves the names, and `push`
 * refuses on it.
 */
export function serviceRoleRoutes(cfg: SupatypeProjectConfig): string[] {
  const declared = cfg.functions?.serviceRole ?? []
  return [...declared].map((entry) => entry.trim()).filter((entry) => entry.length > 0).sort()
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
  return externalDatabaseUrl(cfg) ?? cfg.connection ?? process.env["DATABASE_URL"] ?? localDSN(cfg)
}

/** True when the project points at a Postgres it does not manage. */
export function usesExternalDatabase(cfg: SupatypeProjectConfig): boolean {
  return externalDatabaseUrl(cfg) !== undefined
}

/**
 * The external Postgres URL, or undefined for a managed one.
 *
 * Ahead of `connection` and `DATABASE_URL` in [`connectionString`] on purpose: a stated external
 * database is the whole stack's database, and a CLI command that pushed somewhere else while the
 * services read from here would look exactly like data loss.
 */
export function externalDatabaseUrl(cfg: SupatypeProjectConfig): string | undefined {
  const url = cfg.database.external?.url?.trim()
  return url && url.length > 0 ? url : undefined
}

/**
 * Whether realtime should run.
 *
 * `false` only when stated. An external database that cannot support logical replication is detected
 * rather than declared: the capability record is what Studio and `doctor` read, so an operator who
 * has not thought about it gets a truthful answer instead of a silent default.
 */
export function realtimeEnabled(cfg: SupatypeProjectConfig): boolean {
  return cfg.database.external?.realtime ?? true
}

/** The Postgres schema Supatype manages. */
export function pgSchema(cfg: SupatypeProjectConfig): string {
  const declared = cfg.schema?.pg_schema?.trim()
  return declared && declared.length > 0 ? declared : "public"
}

/**
 * Schemas the stack exposes for its own sake, beyond the one Supatype manages.
 *
 * Dev used to omit `auth` while self-host exposed it, so the same request could work against a
 * self-hosted stack and 404 locally. One list for both.
 */
export const STACK_API_SCHEMAS = ["supatype", "graphql_public", "auth"] as const

/**
 * Schemas to expose over REST, as `PGRST_DB_SCHEMA` wants them.
 *
 * The managed schema first, then what the stack needs for itself. Derived rather than hardcoded
 * because the literal version silently ignored `pg_schema`: the engine would migrate into `app`
 * while PostgREST kept serving `public`, so every request answered `PGRST106` and nothing in the
 * output mentioned the setting that caused it.
 *
 * `api_schemas` replaces the whole list when stated, including the stack schemas, so dropping
 * `supatype` from it is a supported way to stop exposing Studio's views. Order is preserved and
 * duplicates removed: PostgREST serves the first entry as the default profile, so the managed
 * schema has to lead.
 */
export function apiSchemas(cfg: SupatypeProjectConfig, tier?: "none" | "extension" | "views"): string[] {
  const explicit = cfg.schema?.api_schemas
  // Tier-2 field masking serves from `api`, and the managed schema must come **off** the list: a
  // client picks its schema per request with `Accept-Profile`, so leaving it exposed would let any
  // caller read the unmasked table and make the mask opt-out. The API roles hold no privileges there
  // under tier 2 either, so exposing it would only produce denials.
  const managed = tier === "views" ? "api" : pgSchema(cfg)
  const list = explicit && explicit.length > 0 ? explicit : [managed, ...STACK_API_SCHEMAS]

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const name = raw.trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** `PGRST_DB_SCHEMA` value: comma-separated, in order. */
export function apiSchemaList(
  cfg: SupatypeProjectConfig,
  tier?: "none" | "extension" | "views",
): string {
  return apiSchemas(cfg, tier).join(", ")
}
