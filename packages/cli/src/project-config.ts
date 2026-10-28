import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readComposeEnvInt } from "./env-file.js"
import { DEV_DB_PORT_ENV } from "./db-port.js"
import type { ComponentVersions } from "./components.js"
import { validateAuthProviders, type AuthProvidersConfig } from "./auth-providers.js"
import { validateAuthEmail } from "./mailer-autoconfirm.js"
import { validateStudioAuth, type StudioConfig } from "./studio-auth-config.js"
import { STUDIO_ROLES, type StudioRole } from "./studio-roles.js"
import { isJsonObject, isString } from "@supatype/shared"
import { objectAt } from "./ast-read.js"

// ---------------------------------------------------------------------------
// Config schema (single canonical shape; loaded from supatype.config.ts)
// ---------------------------------------------------------------------------

export interface SupatypeProjectConfig {
  /**
   * Runtime stack for local dev and `supatype update`.
   * "docker" = self-host Compose stack (default). "native" = host binaries.
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
     * Port the native Postgres listens on (provider=native, default 5432). `SUPATYPE_DEV_DB_PORT`,
     * exported or in `.env`, wins over it, as it does for the Docker provider's Postgres.
     */
    port?: number
    /**
     * Docker image to use (provider=docker).
     * Defaults to the supatype/postgres release this CLI was tested with.
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
    /**
     * Port realtime listens on in native dev (default: 4000). `SUPATYPE_REALTIME_PORT`, exported
     * or in `.env`, wins over it.
     */
    realtimePort?: number
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
  /** The API as browsers reach it. */
  api?: {
    /**
     * Browser origins allowed to call the API outside dev mode, besides the site URL (`SITE_URL`).
     * Each is `scheme://host[:port]`; `"*"` allows every origin and is never a default.
     * `SUPATYPE_CORS_ALLOW_ORIGINS` in `.env` adds to this list. A list saved in Studio (the
     * Settings page's CORS tab) replaces both until it is reset. Dev mode allows every origin
     * whatever this says.
     */
    corsOrigins?: string[]
  }
  /**
   * Where the REST response cache and Kong's ACME certificates live.
   *
   * Both speak RESP, so this is a choice of server rather than of feature.
   */
  cache?: {
    /**
     * "pg_keyspace" (default) = the RESP keyspace inside the Postgres
     *                           container, so the stack runs one stateful
     *                           service instead of two.
     * "valkey"                = a Valkey sidecar container.
     *
     * pg_keyspace needs `shared_preload_libraries`, which is a property of the
     * Postgres this stack starts, so it is only available when Supatype
     * provisions the database. With `database.external` the default resolves
     * to Valkey, because there is no container to configure; asking for
     * pg_keyspace explicitly there is rejected rather than ignored.
     *
     * Set "valkey" to keep the sidecar. Nothing about the cache's behaviour
     * changes with the answer: both speak RESP and both hold the same keys.
     */
    provider?: "valkey" | "pg_keyspace"
    /**
     * Extra key prefixes to persist when `provider` is "pg_keyspace".
     *
     * The keyspace is a cache: everything is ephemeral, living in shared
     * memory and not surviving a restart of the database. The exception is
     * Kong's ACME certificates, which are always kept. You do not have to
     * name them, and re-issuing them on every restart would meet Let's
     * Encrypt's rate limits.
     *
     * List a prefix here only for something you are storing yourself that
     * must outlive a restart. Each durable write goes through the WAL, which
     * is the cost being avoided everywhere else. Each entry is a prefix of the
     * key as stored (see `pg_keyspace.durability_overrides`).
     */
    durablePrefixes?: string[]
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
     * "resend"  = Resend API (requires SUPATYPE_RESEND_API_KEY, SUPATYPE_RESEND_FROM)
     * "ses"     = AWS SES v2 (ambient credentials, requires SUPATYPE_SES_FROM)
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
    /** Resend API key (provider=resend, or set SUPATYPE_RESEND_API_KEY in `.env`). */
    resend_api_key?: string
    /** From address for Resend (provider=resend, or set SUPATYPE_RESEND_FROM in `.env`). */
    resend_from?: string
    /** From address for SES (provider=ses, or set SUPATYPE_SES_FROM in `.env`). */
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
  /** The auth server's sign-in options. Email delivery itself is `email` above. */
  auth?: {
    email?: {
      /**
       * Make a new email sign-up confirm the address before it can sign in, as Supabase's
       * `[auth.email] enable_confirmations`. Off when unset: a dev stack auto-confirms.
       *
       * Rendered as `SUPATYPE_MAILER_AUTOCONFIRM` for `dev`, native `dev` and the self-host compose
       * file. A `SUPATYPE_MAILER_AUTOCONFIRM` you write into `.env` yourself wins over this.
       */
      enableConfirmations?: boolean
    }
    /**
     * OAuth providers, keyed by the name `signInWithOAuth({ provider })` takes:
     *
     * ```ts
     * auth: { providers: { github: { clientId: "Iv1.abc", secret: env("GITHUB_SECRET") } } }
     * ```
     *
     * Rendered as the `SUPATYPE_EXTERNAL_<PROVIDER>_*` variables the server reads, for `dev` and
     * for the self-host compose file. The redirect URI defaults to `<public API URL>/auth/v1/callback`;
     * register that URL with the provider. A `SUPATYPE_EXTERNAL_*` value in `.env` wins over this.
     */
    providers?: AuthProvidersConfig
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
  /**
   * Drafts and preview links, for the models that declare `versions`.
   *
   * Project-wide rather than per model: a draft is a draft whichever model it belongs to, and a
   * reviewer granted sight of one is not granted it a table at a time.
   */
  publishing?: {
    /**
     * Studio roles that see every unpublished draft and its history, beyond the record's own
     * creator. Defaults to all three, `["admin", "developer", "editor"]`.
     *
     * The record's creator always sees their own drafts and is not listed here. Narrowing this is
     * the interesting case, and it has a trap: whoever may **update** a record may draft and publish
     * it, so a role that can edit but cannot see drafts will build its save on the live row and
     * discard a colleague's pending work. Take a role off this list only where it also cannot edit.
     *
     * An empty list narrows visibility to creators alone.
     *
     * `anon` is never on this list and cannot be put on it. A draft schema readable without
     * credentials would make publishing mean nothing.
     *
     * Studio can override this at runtime for a project that needs to change it without a push.
     * This is the reviewable default that lives in git.
     */
    draft_visibility?: readonly StudioRole[]
    /** Signed, expiring links that let someone without an account read a draft. */
    preview?: {
      /** Lifetime of a minted link when the request does not ask for one, in seconds. Default 900. */
      default_ttl?: number
      /** Ceiling for a link covering one record, in seconds. Default 604800, seven days. */
      max_record_ttl?: number
      /**
       * Ceiling for a link covering every draft in the project, in seconds. Default 86400, one day.
       *
       * Shorter than a record link on purpose: the blast radius is every unpublished draft there is,
       * so the window in which a leaked link is still worth anything should be smaller.
       */
      max_project_ttl?: number
      /**
       * Whether project-scoped links may be minted at all. Default true.
       *
       * Set false for a project where nothing should ever be shareable in bulk; record links keep
       * working. Minting one is already restricted to `admin` and `developer`, since nobody can
       * grant sight of drafts they cannot see themselves.
       */
      allow_project_scope?: boolean
    }
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
    /**
     * Where each model renders in your own front end, keyed by model name.
     *
     * Studio needs this for two things that look alike and are not: the live preview pane, which
     * streams unsaved keystrokes into an iframe, and a shared preview link, which points somebody
     * with no account at a saved draft. Both need the same answer to "what is the address of this
     * record", and neither can guess it.
     *
     * Without it there is no share link to give out. Studio says so rather than handing over the
     * bare code, because a credential with nowhere to open it reads as a bug.
     *
     * `urlPattern` names fields in braces and they are filled from the record in hand, so a post
     * previews at the address its current slug implies.
     *
     * **A path is enough when this deployment serves the app.** With `app.mode` set to `static` or
     * `proxy`, the app is served at `/` on the same origin as the API, and Studio resolves a path
     * against the origin it is loaded from. Writing the origin out again only risks it going stale:
     *
     * ```ts
     * admin: { livePreview: { Post: { urlPattern: "/preview/{slug}" } } }
     * ```
     *
     * With `app.mode: "none"` the app is somewhere else and no deployment fact can say where, so
     * give an absolute URL. `supatype push` refuses a path-only pattern in that mode rather than
     * letting it become a link that resolves to nothing.
     *
     * ```ts
     * admin: { livePreview: { Post: { urlPattern: "https://example.com/preview/{slug}" } } }
     * ```
     */
    livePreview?: Record<string, { url?: string; urlPattern?: string }>
  }
  /**
   * Studio's sign-in. Studio offers every OAuth provider the project has enabled; name some to
   * offer only those. Access still needs a Studio role, however somebody signs in:
   *
   * ```ts
   * studio: { auth: { providers: ["keycloak"] } }
   * ```
   */
  studio?: StudioConfig
}

// ---------------------------------------------------------------------------
// Merge + validate
// ---------------------------------------------------------------------------

type ConfigKey = keyof SupatypeProjectConfig

/** Part of a section: a local config sets the fields it changes, at any depth. */
type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [F in keyof T]?: DeepPartial<T[F]> } : T

/** A local config (`supatype.local.config.ts`): any section, and within it any of its fields. */
export type ProjectConfigOverride = { [K in ConfigKey]?: DeepPartial<SupatypeProjectConfig[K]> }

/**
 * One section merged. Sections are read here as the objects they are at runtime; the merged config
 * is checked as a whole afterwards (`isProjectConfig`, then `validateProjectConfig` by the caller).
 */
type MergeFn = (base: unknown, override: unknown) => unknown

/** A value the local config replaces whole (a string, a choice). */
function replace(base: unknown, override: unknown): unknown {
  return override ?? base
}

/** The value's own fields, or none when it is not an object. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {}
}

/** A section merged a field at a time, the local config's fields winning. */
function shallow(base: unknown, override: unknown): Record<string, unknown> {
  return { ...fieldsOf(base), ...fieldsOf(override) }
}

/** A section merged a field at a time, with its `field` (itself a section) merged the same way. */
function nested(field: string): MergeFn {
  return (base, override) => {
    const merged = shallow(base, override)
    const b = fieldsOf(base)[field]
    const o = fieldsOf(override)[field]
    if (b === undefined && o === undefined) return merged
    return { ...merged, [field]: shallow(b, o) }
  }
}

/**
 * `auth` from the local config on top of the base, a provider at a time, so a local file can swap one
 * provider's client id for a development OAuth app without restating the others.
 */
function mergeAuth(base: unknown, override: unknown): unknown {
  const baseProviders = fieldsOf(fieldsOf(base)["providers"])
  const overrideProviders = fieldsOf(fieldsOf(override)["providers"])
  const names = new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])
  const merged = shallow(base, override)
  if (names.size === 0) return merged
  const providers = Object.fromEntries(
    [...names].map((name) => [name, shallow(baseProviders[name], overrideProviders[name])]),
  )
  return { ...merged, providers }
}

/**
 * How each top-level key is merged. Typed over every key of the config, so a key added to
 * `SupatypeProjectConfig` does not compile until it is given a rule here: the fixed list this
 * replaced dropped `cache`, `api` and `publishing` from a local config without a word.
 */
const MERGE_RULES: { [K in ConfigKey]: MergeFn } = {
  provider: replace,
  supatype: shallow,
  project: shallow,
  database: shallow,
  server: shallow,
  api: shallow,
  cache: shallow,
  app: shallow,
  versions: shallow,
  overrides: shallow,
  email: nested("smtp"),
  auth: mergeAuth,
  storage: shallow,
  schema: shallow,
  publishing: nested("preview"),
  functions: shallow,
  output: shallow,
  build: shallow,
  environments: nested("branchDefaults"),
  connection: replace,
  admin: shallow,
  studio: nested("auth"),
}

/**
 * Merge each top-level section from `override` on top of `base`.
 * Within each section, override values win. New optional sections in override are added, and a key
 * with no rule (one a config sets that the type does not know) is kept, the override winning.
 *
 * `override` is a typed local config, or one as loaded from its file; the caller validates the
 * result either way, since the merge can bring together settings each file was valid without.
 */
export function mergeProjectConfig(
  base: SupatypeProjectConfig,
  override: ProjectConfigOverride | Readonly<Record<string, unknown>>,
): SupatypeProjectConfig {
  const baseFields: Record<string, unknown> = { ...base }
  const overrideFields: Record<string, unknown> = { ...override }
  const merged: Record<string, unknown> = { ...baseFields, ...overrideFields }
  for (const [key, rule] of Object.entries(MERGE_RULES)) {
    if (baseFields[key] === undefined && overrideFields[key] === undefined) delete merged[key]
    else merged[key] = rule(baseFields[key], overrideFields[key])
  }
  if (!isProjectConfig(merged)) throw new Error("The merged config lost a section the base config had")
  return merged
}

/**
 * Where a config object becomes a `SupatypeProjectConfig`, the one check this module cannot make in
 * full. The sections every command reads (`project.name`, `database`, `server`, `app`) are checked
 * here, and the validators below check the sections they own; the remaining fields are the config
 * author's, typed by `defineConfig` against this same interface, and read where they are used.
 */
function isProjectConfig(value: unknown): value is SupatypeProjectConfig {
  return (
    isJsonObject(value) &&
    typeof objectAt(value, "project")?.["name"] === "string" &&
    Boolean(value["database"]) &&
    Boolean(value["server"]) &&
    Boolean(value["app"])
  )
}

export function validateProjectConfig(raw: unknown, filename: string): SupatypeProjectConfig {
  if (!isJsonObject(raw)) {
    throw new Error(`${filename}: expected a config object at the root`)
  }

  const cfg = raw

  if (typeof objectAt(cfg, "project")?.["name"] !== "string") {
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
  validateCache(cfg, filename)
  validateSchemaNames(cfg, filename)
  validateAuthProviders(cfg, filename)
  validateAuthEmail(cfg, filename)
  validateCorsOrigins(cfg, filename)
  validateStudioAuth(cfg, filename)

  if (!isProjectConfig(cfg)) throw new Error(`${filename}: not a project config`)
  return cfg
}

/**
 * True for `*` or an origin the server will match: an http or https scheme and a host, an optional
 * port, and nothing after it. The server refuses anything else when a list is saved, and a config
 * entry it could never match would only look like an allowed origin.
 */
export function isCorsOriginEntry(entry: string): boolean {
  if (entry === "*") return true
  try {
    const url = new URL(entry)
    const afterScheme = entry.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "")
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      !/[/?#@]/.test(afterScheme)
    )
  } catch {
    return false
  }
}

/** `api.corsOrigins`: an array of origins or `*`, refused when the config is read. */
function validateCorsOrigins(cfg: Record<string, unknown>, filename: string): void {
  const origins = objectAt(cfg, "api")?.["corsOrigins"]
  if (origins === undefined) return
  const bad = Array.isArray(origins)
    ? origins.filter((o) => typeof o !== "string" || !isCorsOriginEntry(o.trim()))
    : [origins]
  if (bad.length > 0) {
    throw new Error(
      `${filename}: api.corsOrigins must be an array of origins (scheme://host[:port]) or "*"; ` +
        `not ${bad.map((b) => JSON.stringify(b)).join(", ")}`,
    )
  }
}

/** A Postgres name Supatype can write anywhere without quoting it (Q1, Q3). */
const PLAIN_SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/

/** Postgres keeps 63 bytes of a name (`NAMEDATALEN` - 1) and cuts the rest. */
const MAX_SCHEMA_NAME_BYTES = 63

/**
 * `schema.pg_schema` and every `schema.api_schemas` entry must be a plain identifier.
 *
 * They are written unquoted in places: the masking labels, `PGRST_DB_SCHEMA`, the search path. A
 * `$` can end a dollar-quoted function body, and a capital or a hyphen means a different schema,
 * or none, wherever the name is not quoted. Refused when the config is read, before anything is
 * generated from it; the engine refuses the same names at its own boundary.
 */
function validateSchemaNames(cfg: Record<string, unknown>, filename: string): void {
  const schema = objectAt(cfg, "schema")
  if (schema === undefined) return
  const pgSchema = schema["pg_schema"]
  const apiSchemas = schema["api_schemas"]
  if (pgSchema !== undefined) assertPlainSchemaName(pgSchema, "schema.pg_schema", filename)
  if (Array.isArray(apiSchemas)) {
    for (const name of apiSchemas) assertPlainSchemaName(name, "schema.api_schemas", filename)
  }
}

function assertPlainSchemaName(name: unknown, key: string, filename: string): void {
  const text = typeof name === "string" ? name.trim() : name
  if (
    typeof text === "string" &&
    PLAIN_SCHEMA_NAME.test(text) &&
    Buffer.byteLength(text, "utf8") <= MAX_SCHEMA_NAME_BYTES
  ) {
    return
  }
  throw new Error(
    `${filename}: ${key} ${JSON.stringify(name)} is not a plain identifier: a schema name must match ` +
      `^[a-z_][a-z0-9_]*$ and be at most ${MAX_SCHEMA_NAME_BYTES} bytes`,
  )
}

/**
 * `cache.provider = "pg_keyspace"` describes how the Postgres this stack
 * starts is configured, so it cannot be honoured against a database Supatype
 * does not manage. Rejected rather than silently falling back to Valkey: a
 * stack that quietly runs the thing you switched away from is worse than one
 * that will not start.
 */
function validateCache(cfg: Record<string, unknown>, filename: string): void {
  const cache = objectAt(cfg, "cache")
  if (!cache) return
  const provider = cache["provider"]
  if (provider !== undefined && provider !== "valkey" && provider !== "pg_keyspace") {
    throw new Error(
      `${filename}: cache.provider must be "valkey" or "pg_keyspace" (got ${JSON.stringify(provider)})`,
    )
  }
  if (provider === "pg_keyspace" && objectAt(cfg, "database")?.["external"]) {
    throw new Error(
      `${filename}: cache.provider = "pg_keyspace" needs the Postgres this stack starts: ` +
        `it is loaded with shared_preload_libraries, which is not something Supatype can set on ` +
        `a database.external one. Use cache.provider = "valkey", or drop database.external.`,
    )
  }
  const prefixes = cache["durablePrefixes"]
  if (prefixes !== undefined) {
    if (!Array.isArray(prefixes) || prefixes.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new Error(`${filename}: cache.durablePrefixes must be an array of non-empty strings`)
    }
    // `,` separates entries and `=` separates a prefix from its tier in
    // pg_keyspace.durability_overrides, so a prefix containing either would be
    // read as two settings. Refused here rather than mangled into the command
    // line, where it would surface as a Postgres that will not start.
    const bad = prefixes.filter(isString).find((p) => p.includes(",") || p.includes("="))
    if (bad) {
      throw new Error(
        `${filename}: cache.durablePrefixes entry ${JSON.stringify(bad)} cannot contain "," or "=": ` +
          `both are separators in pg_keyspace.durability_overrides`,
      )
    }
  }
}

/**
 * Rules for `database.external`, all of them errors rather than precedence.
 *
 * Every one of these is a case where two settings describe the same fact and the stack would have to
 * pick. A silent winner is how you end up with a push that went somewhere other than where the
 * services are reading, which looks like data loss and is not.
 */
function validateExternalDatabase(cfg: Record<string, unknown>, filename: string): void {
  const database = objectAt(cfg, "database")
  const external = database?.["external"]
  if (external === undefined) return

  if (!isJsonObject(external)) {
    throw new Error(`${filename}: database.external must be an object with a url`)
  }

  const url = external["url"]
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

  const realtime = external["realtime"]
  if (realtime !== undefined && typeof realtime !== "boolean") {
    throw new Error(`${filename}: database.external.realtime must be true or false`)
  }

  if (database?.["provider"] !== undefined) {
    throw new Error(
      `${filename}: database.provider ("${String(database["provider"])}") and database.external ` +
        "cannot both be set, provider chooses a Postgres for Supatype to run, external says one " +
        "already exists.\n" +
        "Remove database.provider. The runtime stack is still chosen by the top-level `provider`.",
    )
  }

  if (objectAt(cfg, "server")?.["mode"] === "managed") {
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
 *
 * A docker dev project answers on its own Kong port, as compose binds it. This used to return the
 * default port 18473 for every docker project, which is another project's gateway on a machine
 * running two (A3-N4, A4-N2); with no port recorded there is no address to give.
 */
export function serverBaseUrl(cfg: SupatypeProjectConfig, cwd: string = process.cwd()): string | undefined {
  const port = cfg.server.port ?? 54321
  switch (cfg.server.mode) {
    case "dev":
    case "standalone":
      if (cfg.server.mode === "dev" && resolveRuntimeProvider(cfg) === "docker") {
        const kongPort = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT")
        return kongPort === null ? undefined : `http://localhost:${kongPort}`
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

/**
 * Resolved runtime provider (`config.provider` ?? `database.provider` ?? docker).
 *
 * Docker is the default: `init` scaffolds `provider: "docker"`, and a config with no provider line
 * runs the same stack. Native is opt-in with `provider: "native"`.
 */
export function resolveRuntimeProvider(cfg: SupatypeProjectConfig): "native" | "docker" {
  return cfg.provider ?? cfg.database.provider ?? "docker"
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

/**
 * The local Postgres DSN derived from project name (dev default).
 *
 * `password` is the superuser's, `.env`'s POSTGRES_PASSWORD (`devPostgresPassword`). The native
 * cluster checks it, so the `postgres` default only reaches a cluster still set up that way.
 */
export function localDSN(cfg: SupatypeProjectConfig, password = "postgres", cwd: string = process.cwd()): string {
  const port = nativeDbPort(cfg, cwd)
  return `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${cfg.project.name}?sslmode=disable`
}

/** Where native Postgres listens when nothing moves it. */
export const NATIVE_DB_PORT = 5432

/** Where native realtime listens when nothing moves it. */
export const NATIVE_REALTIME_PORT = 4000

/** The environment key that moves native realtime, read like the Docker provider's port keys. */
export const REALTIME_PORT_ENV = "SUPATYPE_REALTIME_PORT"

/**
 * The port native Postgres listens on: `SUPATYPE_DEV_DB_PORT` (exported, then `.env`), then
 * `database.port`, then 5432.
 *
 * The same key as the Docker provider's dev Postgres, because it means the same thing: the port
 * on this machine where the project's dev database answers. It used to be fixed at 5432, so native
 * dev could not run beside any other Postgres.
 */
export function nativeDbPort(cfg: SupatypeProjectConfig, cwd: string = process.cwd()): number {
  return readComposeEnvInt(cwd, DEV_DB_PORT_ENV) ?? cfg.database?.port ?? NATIVE_DB_PORT
}

/** Where native dev keeps a project's Postgres data, logs, pid files and local storage. */
export function nativeStateRoot(cfg: SupatypeProjectConfig): string {
  return join(homedir(), ".supatype", "projects", cfg.project.name)
}

/** The native Postgres data directory: `database.data_dir`, or the one in the state directory. */
export function nativeDataDir(cfg: SupatypeProjectConfig): string {
  return cfg.database.data_dir ?? join(nativeStateRoot(cfg), "data")
}

/** The port native realtime listens on: `SUPATYPE_REALTIME_PORT`, then `server.realtimePort`, then 4000. */
export function nativeRealtimePort(cfg: SupatypeProjectConfig, cwd: string = process.cwd()): number {
  return readComposeEnvInt(cwd, REALTIME_PORT_ENV) ?? cfg.server?.realtimePort ?? NATIVE_REALTIME_PORT
}

/**
 * Resolve the database connection string.
 * Prefers optional `connection` in config, then `DATABASE_URL` env, then a local default DSN with
 * `localPassword` as the superuser's password, on the native port `cwd`'s `.env` names.
 */
export function connectionString(
  cfg: SupatypeProjectConfig,
  localPassword?: string,
  cwd: string = process.cwd(),
): string {
  return externalDatabaseUrl(cfg) ?? cfg.connection ?? process.env["DATABASE_URL"] ?? localDSN(cfg, localPassword, cwd)
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
 * The schema holding generated draft views, one per versioned model.
 *
 * Its own schema rather than a suffix on the table name, so a draft has the same table name and the
 * same row type as what it is a draft of, and a client reaches it by switching profile.
 */
export const DRAFT_SCHEMA = "draft"

/** What shapes the exposed-schema list, beyond the config itself. */
export type ApiSchemaOptions = {
  /** How field rules will be enforced here. `views` moves the managed schema off the list. */
  tier?: "none" | "extension" | "views" | undefined
  /** True when any model declares `versions`, which is what puts the `draft` schema on the list. */
  drafts?: boolean | undefined
}

/**
 * Schemas to expose over REST, as `PGRST_DB_SCHEMA` wants them.
 *
 * The managed schema first, then what the stack needs for itself. Derived rather than hardcoded
 * because the literal version silently ignored `pg_schema`: the engine would migrate into `app`
 * while PostgREST kept serving `public`, so every request answered `PGRST106` and nothing in the
 * output mentioned the setting that caused it.
 *
 * `api_schemas` replaces the whole list when stated, including the stack schemas, so dropping
 * `supatype` from it is a supported way to stop exposing Studio's views. That holds for `draft` too:
 * an explicit list has to name it, and `db check` reports a project whose models declare `versions`
 * against a list that does not. Order is preserved and duplicates removed: PostgREST serves the first
 * entry as the default profile, so the managed schema has to lead.
 */
export function apiSchemas(cfg: SupatypeProjectConfig, options?: ApiSchemaOptions): string[] {
  const explicit = cfg.schema?.api_schemas
  // Tier-2 field masking serves from `api`, and the managed schema must come **off** the list: a
  // client picks its schema per request with `Accept-Profile`, so leaving it exposed would let any
  // caller read the unmasked table and make the mask opt-out. The API roles hold no privileges there
  // under tier 2 either, so exposing it would only produce denials.
  const managed = options?.tier === "views" ? "api" : pgSchema(cfg)
  // `draft` sits behind the managed schema and never in front of it: the first entry is the default
  // profile, and a client that named no profile reading drafts by default would invert the feature.
  const derived = options?.drafts === true
    ? [managed, DRAFT_SCHEMA, ...STACK_API_SCHEMAS]
    : [managed, ...STACK_API_SCHEMAS]
  const list = explicit && explicit.length > 0 ? explicit : derived

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
export function apiSchemaList(cfg: SupatypeProjectConfig, options?: ApiSchemaOptions): string {
  return apiSchemas(cfg, options).join(", ")
}

/**
 * `PGRST_DB_EXTRA_SEARCH_PATH` value, which is also the search path pg_graphql reflects.
 *
 * Under tier 2 that is `api`, so GraphQL serves the masked views and never the base tables: with
 * `public` there it reflected tables the API roles hold no privileges on, which left end users no
 * model at all and gave service_role the unmasked rows (F64). Every other tier keeps `public`.
 * Unqualified names in column defaults (`uuid_generate_v4()`) resolve through `extensions` either way.
 */
export function postgrestSearchPath(options?: ApiSchemaOptions): string {
  return options?.tier === "views" ? "api,extensions" : "public,extensions"
}

/** The schema half of PostgREST's environment, both values decided by the same tier. */
export function postgrestSchemaEnv(
  cfg: SupatypeProjectConfig,
  options?: ApiSchemaOptions,
): { PGRST_DB_SCHEMA: string; PGRST_DB_EXTRA_SEARCH_PATH: string } {
  return {
    PGRST_DB_SCHEMA: apiSchemaList(cfg, options),
    PGRST_DB_EXTRA_SEARCH_PATH: postgrestSearchPath(options),
  }
}

/**
 * Studio roles that see every draft, beyond each record's own creator.
 *
 * Every role that writes, which is to say anyone with Studio write access; a `viewer` writes nothing
 * and sees drafts only when the project names them. It was narrower, `admin` and
 * `developer` only, and that put two decisions in conflict: whoever may **update** a record may
 * draft and publish it, so an `editor` could edit a record whose pending draft they could not see,
 * and their save would be built on the live row and silently discard a colleague's work. Two editors
 * on one post is the ordinary editorial case, not an exotic one. Seeing and acting line up instead.
 *
 * The creator is not in this list and cannot be removed from it: they wrote the draft, and a system
 * where you cannot read back what you just saved is broken rather than secure. An empty configured
 * list is honoured and means creators only, which is why this cannot fall back on emptiness.
 *
 * `anon` is not a Studio role and can never be here. A draft readable without credentials would make
 * publishing mean nothing.
 */
export const DEFAULT_DRAFT_VISIBILITY = ["admin", "developer", "editor"] as const

/** Studio roles a Supatype project understands, most privileged first (`studio-roles.ts`). */
export { STUDIO_ROLES }

/**
 * The configured draft-visibility roles, or the default when the project states none.
 *
 * An unknown role name is dropped rather than passed through to a policy, where it would be a role
 * nothing can ever hold: a typo would then read as a working setting that silently grants nobody.
 */
export function draftVisibilityRoles(cfg: SupatypeProjectConfig): string[] {
  const declared = cfg.publishing?.draft_visibility
  if (declared === undefined) return [...DEFAULT_DRAFT_VISIBILITY]
  const known = new Set<string>(STUDIO_ROLES)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of declared) {
    const role = raw.trim().toLowerCase()
    if (!known.has(role) || seen.has(role)) continue
    seen.add(role)
    out.push(role)
  }
  return out
}

/** Bounds on a minted preview link, in seconds. */
export type PreviewLimits = {
  defaultTtl: number
  maxRecordTtl: number
  maxProjectTtl: number
  allowProjectScope: boolean
}

export const PREVIEW_DEFAULTS: PreviewLimits = {
  defaultTtl: 900,
  maxRecordTtl: 604800,
  maxProjectTtl: 86400,
  allowProjectScope: true,
}

/**
 * The project's preview-link bounds, defaults filled in.
 *
 * A stated value is clamped to at least a second and, for the default lifetime, to no more than the
 * ceiling it would be issued against: a `default_ttl` above `max_record_ttl` would otherwise mint
 * links that the same config refuses to honour.
 */
export function previewLimits(cfg: SupatypeProjectConfig): PreviewLimits {
  const declared = cfg.publishing?.preview
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback

  const maxRecordTtl = positive(declared?.max_record_ttl, PREVIEW_DEFAULTS.maxRecordTtl)
  const maxProjectTtl = positive(declared?.max_project_ttl, PREVIEW_DEFAULTS.maxProjectTtl)
  return {
    defaultTtl: Math.min(
      positive(declared?.default_ttl, PREVIEW_DEFAULTS.defaultTtl),
      Math.max(maxRecordTtl, maxProjectTtl),
    ),
    maxRecordTtl,
    maxProjectTtl,
    allowProjectScope: declared?.allow_project_scope ?? PREVIEW_DEFAULTS.allowProjectScope,
  }
}
