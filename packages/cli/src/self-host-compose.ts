import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { requireDockerDaemon, type DockerBrandOptions } from "./docker-runtime.js"
import { fatalError } from "./ui/fatal.js"
import {
  apiSchemaList,
  externalDatabaseUrl,
  hooksPathFromProject,
  preferredFunctionsPathFromProject,
  realtimeEnabled,
  serviceRoleRoutes,
  selfHostTlsEnabled,
  usesExternalDatabase,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { hasEngineOverride, hasStudioOverride, pinnedVersion, fetchLatestVersion, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { buildKongDeclarative } from "./kong-config.js"
import { readEnvFile } from "./env-file.js"
import { fieldMaskingTierFromProject, type FieldMaskingTier } from "./field-masking-tier.js"

/** Env keys written when `versions` pins exist in supatype.config.ts. */
export const COMPOSE_PINNED_IMAGE_ENV_KEYS = [
  "SUPATYPE_ENGINE_IMAGE",
  "SUPATYPE_SERVER_IMAGE",
  "SUPATYPE_POSTGRES_IMAGE",
] as const

/** Compose image env vars that may be overridden manually in `.env`. */
export const COMPOSE_IMAGE_ENV_KEYS = [
  ...COMPOSE_PINNED_IMAGE_ENV_KEYS,
  "SUPATYPE_CONTROL_PLANE_IMAGE",
  "SUPATYPE_AUTH_IMAGE",
  "SUPATYPE_STUDIO_IMAGE",
  "SUPATYPE_STORAGE_IMAGE",
  "SUPATYPE_FUNCTIONS_WORKER_IMAGE",
] as const

type DockerPinComponent = "engine" | "server" | "postgres"

/** Map a config version pin to a Docker Hub image reference. */
export function dockerImageRef(
  component: DockerPinComponent,
  version: string,
  config?: SupatypeProjectConfig,
): string {
  const trimmed = version.trim()
  switch (component) {
    case "engine":
      return `supatype/schema-engine:${trimmed.startsWith("v") ? trimmed : `v${trimmed}`}`
    case "server":
      return `supatype/server:${trimmed.startsWith("v") ? trimmed : `v${trimmed}`}`
    case "postgres": {
      const override = config?.database?.image?.trim()
      if (override) return override
      if (trimmed.includes("-latest")) return `supatype/postgres:${trimmed}`
      const major = trimmed.split(".")[0]
      return `supatype/postgres:${major}-latest`
    }
  }
}

/**
 * When the user pins `versions` in config, sync matching SUPATYPE_*_IMAGE vars for Compose.
 * Unpinned components are omitted so compose falls back to :latest defaults.
 */
export function composeDockerImageEnv(config: SupatypeProjectConfig): Record<string, string> {
  const env: Record<string, string> = {}
  const versions = config.versions
  if (!versions) return env

  if (versions.engine && versions.engine !== VERSION_PIN_LOCAL) {
    env.SUPATYPE_ENGINE_IMAGE = dockerImageRef("engine", versions.engine)
  }
  if (versions.server && versions.server !== VERSION_PIN_LOCAL) {
    env.SUPATYPE_SERVER_IMAGE = dockerImageRef("server", versions.server)
  }
  if (versions.postgres && versions.postgres !== VERSION_PIN_LOCAL) {
    env.SUPATYPE_POSTGRES_IMAGE = dockerImageRef("postgres", versions.postgres, config)
  }
  return env
}

/** True when a Docker image tag is a semver/latest ref we expect `docker pull` to resolve. */
export function isRegistryPullableImageRef(ref: string): boolean {
  const trimmed = ref.trim()
  if (!trimmed) return true
  const tag = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : "latest"
  if (tag === "latest") return true
  if (/^v?\d+\.\d+/.test(tag)) return true
  if (/^\d+-latest$/.test(tag)) return true
  return false
}

export function hasLocalVersionPins(config: SupatypeProjectConfig): boolean {
  const versions = config.versions
  if (!versions) return false
  return (
    versions.engine === VERSION_PIN_LOCAL ||
    versions.server === VERSION_PIN_LOCAL ||
    versions.postgres === VERSION_PIN_LOCAL ||
    versions.deno === VERSION_PIN_LOCAL
  )
}

function readComposeImageEnvValues(cwd: string): string[] {
  const envPath = resolve(cwd, ".env")
  if (!existsSync(envPath)) return []
  const text = readFileSync(envPath, "utf8")
  const values: string[] = []
  for (const key of COMPOSE_IMAGE_ENV_KEYS) {
    const match = text.match(new RegExp(`^${key}=(.+)$`, "m"))
    if (match?.[1]) values.push(match[1].trim())
  }
  return values
}

/**
 * Use `docker compose pull --ignore-pull-failures` only when the project may
 * reference local-only images (config `versions: local` or custom `.env` tags).
 */
export function composePullNeedsIgnoreFailures(
  config: SupatypeProjectConfig,
  cwd: string = process.cwd(),
): boolean {
  if (hasLocalVersionPins(config)) return true
  return readComposeImageEnvValues(cwd).some((ref) => !isRegistryPullableImageRef(ref))
}

/**
 * Schema-engine image for a one-off `docker compose run` when pushing schema.
 * Uses config pin when set; otherwise CDN engine semver (Docker Hub `:latest` can lag).
 * Does not touch `.env`, server/postgres still use compose `:latest` defaults.
 */
export async function schemaEngineImageForPush(
  config: SupatypeProjectConfig,
): Promise<string | undefined> {
  const pinned = pinnedVersion("engine", config)
  if (pinned === VERSION_PIN_LOCAL) return undefined
  if (pinned) return dockerImageRef("engine", pinned)
  const version = await fetchLatestVersion("engine")
  return dockerImageRef("engine", version)
}

export interface SelfHostComposePaths {
  dir: string
  composePath: string
  kongPath: string
  nginxPath: string
}

export function selfHostComposePaths(cwd: string): SelfHostComposePaths {
  const dir = resolve(cwd, ".supatype", "self-host")
  return {
    dir,
    composePath: join(dir, "docker-compose.yml"),
    kongPath: join(dir, "kong.yml"),
    nginxPath: join(dir, "nginx.conf"),
  }
}

export function appUpstreamForCompose(config: SupatypeProjectConfig): string | undefined {
  if (config.app.mode !== "proxy") return undefined
  const upstream = config.app.upstream?.trim()
  return upstream && upstream.length > 0 ? upstream : undefined
}

export function staticDirForCompose(config: SupatypeProjectConfig): string | undefined {
  if (config.app.mode !== "static") return undefined
  const dir = config.app.static_dir?.trim()
  return dir && dir.length > 0 ? dir : "./public"
}

/**
 * Bind-mount source for `/project` in generated compose files.
 * Paths are resolved from `--project-directory` (always the project root in `runDockerCompose`),
 * not from the compose file directory, use `.` not `../..`.
 */
function projectMountPath(_cwd: string): string {
  return "."
}

/** Paths in generated compose are resolved from `--project-directory` (project root). */
function relativeFromProjectRoot(cwd: string, target: string): string {
  let rel = relative(resolve(cwd), resolve(target)).replace(/\\/g, "/")
  if (!rel.startsWith(".") && !rel.startsWith("/")) {
    rel = `./${rel}`
  }
  return rel
}

function kongMountPath(_cwd: string): string {
  return ".supatype/self-host/kong.yml"
}

/**
 * The DSN every service uses for the schema-owning role.
 *
 * One expression instead of six identical constructions of `@db:5432`. With an external database it
 * becomes `${DATABASE_URL:?…}`: the URL is the operator's, so there is nothing for the generator to
 * build: and interpolating the value into the compose file would write a password into a generated
 * file. Compose resolves the variable from `.env` at up-time, the same place the config's
 * `process.env.DATABASE_URL` read it from.
 */
function ownerDatabaseUrl(config: SupatypeProjectConfig, scheme = "postgresql"): string {
  if (usesExternalDatabase(config)) {
    return "${DATABASE_URL:?DATABASE_URL is missing from .env, required by database.external}"
  }
  return (
    `${scheme}://\${POSTGRES_USER:-supatype_admin}:` +
    "\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing from .env}" +
    "@db:5432/\${POSTGRES_DB:-supatype}"
  )
}

/**
 * PostgREST's DSN, which connects as `authenticator` rather than the owner.
 *
 * For an external database the host, port, database and query string are taken from the operator's
 * URL and only the password stays a variable. The alternative, a second full URL in `.env`, is one
 * more thing to keep in step with the first, and two URLs that disagree about *which database* is a
 * split-brain nobody notices until the API is serving one and migrations are landing in the other.
 * A hostname is not the secret here; the password is, and it stays out of the generated file.
 */
function postgrestDatabaseUrl(config: SupatypeProjectConfig): string {
  const password = "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is missing from .env}"
  const externalUrl = externalDatabaseUrl(config)
  if (externalUrl === undefined) {
    return `postgresql://authenticator:${password}@db:5432/\${POSTGRES_DB:-supatype}`
  }

  const parsed = new URL(externalUrl)
  const port = parsed.port ? `:${parsed.port}` : ""
  return `postgresql://authenticator:${password}@${parsed.hostname}${port}${parsed.pathname}${parsed.search}`
}

/** Host Vite dev server as seen from Kong inside Docker Compose. */
export const COMPOSE_STUDIO_HOST_URL = "http://host.docker.internal:3002"

/** Studio container: always Docker Hub unless SUPATYPE_STUDIO_IMAGE is set in .env. */
function studioServiceBlock(): string {
  return `    image: \${SUPATYPE_STUDIO_IMAGE:-supatype/studio:latest}`
}

/** Host dev app (Astro/Vite on the machine) as seen from inside compose services. */
function proxyUpstreamForCompose(upstream: string, devLocal: boolean): string {
  const trimmed = upstream.trim()
  if (!devLocal) return trimmed
  try {
    const url = new URL(trimmed)
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal"
      return url.toString()
    }
  } catch {
    // keep literal upstream when not a URL
  }
  return trimmed
}

function serverAppEnvForCompose(config: SupatypeProjectConfig, devLocal: boolean): string {
  const mode = config.app.mode ?? "none"
  const lines = [`      SUPATYPE_APP_MODE: ${mode}`]
  if (mode === "static") {
    const dir = staticDirForCompose(config) ?? "./public"
    lines.push(`      SUPATYPE_APP_STATIC_DIR: /project/${dir.replace(/^\.\//, "")}`)
  } else if (mode === "proxy" && config.app.upstream?.trim()) {
    lines.push(`      SUPATYPE_APP_UPSTREAM: ${proxyUpstreamForCompose(config.app.upstream, devLocal)}`)
  }
  if (config.app.vite_dev_url?.trim()) {
    lines.push(
      `      SUPATYPE_VITE_DEV_URL: ${proxyUpstreamForCompose(config.app.vite_dev_url, devLocal)}`,
    )
  }
  return lines.join("\n")
}

export interface SelfHostComposeOptions {
  /** `supatype dev` with provider docker: internal-only db/server; Kong on host :18473. */
  devLocal?: boolean
  /**
   * Which mechanism enforces per-column rules, when the caller knows.
   *
   * Only the call sites that have loaded the schema can say, see `field-masking-tier.ts`. Left
   * unset, the exposed schema list is today's, which is correct for every project without field
   * rules and for every project on `supatype/postgres`.
   */
  fieldMaskingTier?: FieldMaskingTier
}

export function renderSelfHostCompose(
  config: SupatypeProjectConfig,
  cwd: string = process.cwd(),
  options?: SelfHostComposeOptions,
): string {
  const projectMount = projectMountPath(cwd)
  const kongMount = kongMountPath(cwd)
  const external = usesExternalDatabase(config)
  const ownerUrl = ownerDatabaseUrl(config)
  // the auth driver wants the `postgres://` spelling; an external URL is used as given.
  const authUrl = external ? ownerUrl : ownerDatabaseUrl(config, "postgres")
  // An external URL may already carry query parameters (`?sslmode=require` is common on managed
  // providers), and appending a second `?` produces a DSN that fails to parse.
  const authSearchPathSeparator = externalDatabaseUrl(config)?.includes("?") ? "&" : "?"
  const postgrestUrl = postgrestDatabaseUrl(config)
  const devLocal = options?.devLocal === true
  const tlsEnabled = selfHostTlsEnabled(config, devLocal)
  const domain = config.server.domain?.trim() ?? ""
  // When TLS is on, default external URLs to https://<domain> so auth links/redirects use HTTPS.
  const externalUrlFallback = tlsEnabled ? `https://${domain}` : "http://localhost:18473"
  const siteUrlFallback = tlsEnabled ? `https://${domain}` : "http://localhost:3000"
  const studioHostDev = devLocal && hasStudioOverride(config)
  const appEnv = serverAppEnvForCompose(config, devLocal)
  const staticDir = staticDirForCompose(config) ?? "./dist"
  const composeProject = composeProjectName(config.project.name)
  const studioService = studioServiceBlock()
  const studioBlock = studioHostDev
    ? ""
    : `
  studio:
${studioService}
    environment:
      SUPATYPE_CLOUD_JSON: '{"url":"\${API_EXTERNAL_URL:-${externalUrlFallback}}","anonKey":"\${ANON_KEY:-}"}'
    expose:
      - "3002"
`
  const kongDependsOn = studioHostDev
    ? `      - server
      - control-plane`
    : `      - server
      - studio
      - control-plane`
  const publishDbToHost = !devLocal || hasEngineOverride(config)
  const dbPorts = publishDbToHost
    ? devLocal
      ? `    ports:
      - "127.0.0.1:\${SUPATYPE_DEV_DB_PORT:-54329}:5432"
`
      : `    ports:
      - "5432:5432"
`
    : ""
  const serverPorts = devLocal
    ? ""
    : `    ports:
      - "9999:9999"
`
  const minioPorts = devLocal
    ? ""
    : `    ports:
      - "9000:9000"
      - "9001:9001"
`
  const kongTlsEnv = tlsEnabled
    ? `      KONG_PROXY_LISTEN: "0.0.0.0:8000, 0.0.0.0:8443 ssl"
      KONG_LUA_SSL_TRUSTED_CERTIFICATE: system
      KONG_LUA_SSL_VERIFY_DEPTH: "2"
`
    : ""
  const kongPorts = tlsEnabled
    ? `      - "80:8000"
      - "443:8443"`
    : `      - "\${SUPATYPE_KONG_PORT:-18473}:8000"`
  const valkeyBlock = `
  valkey:
    image: \${SUPATYPE_VALKEY_IMAGE:-valkey/valkey:8-alpine}
    command: ["valkey-server", "--appendonly", "yes"]
    expose:
      - "6379"
    volumes:
      - valkey-data:/data
`
  const kongValkeyDepends = "\n      - valkey"
  const tlsHintComment = tlsEnabled
    ? ""
    : `  # HTTPS is off. To enable automatic TLS (Let's Encrypt) for production, set in supatype.config.ts:
  #   server: { mode: "standalone", domain: "your.domain", tls: { email: "you@example.com" } }
  # then re-run \`supatype self-host compose up -d\`. Kong publishes :80/:443 and provisions certs automatically.
`
  // An external database is not ours to declare a volume for.
  const volumesBlock = `volumes:
${external ? "" : "  db-data:\n"}  minio-data:
  valkey-data:
`

  // `depends_on` for the services that talk to Postgres. With an external database there is no
  // container to wait on, so the clause disappears entirely and each service retries on connect
  // instead: which is also what covers a database that restarts *after* boot, something no
  // healthcheck ever did.
  const dbDependencyClause = external
    ? ""
    : `      db:
        condition: service_healthy
`
  const dbDependency = external ? "" : `    depends_on:\n${dbDependencyClause}`

  // Realtime, omitted entirely when the project has turned it off.
  //
  // Not started-and-disabled: the service degrades gracefully on its own (it reports the reason on
  // /health/ready rather than crash-looping), so this switch is for the operator who has read
  // `supatype db check`, knows their database cannot do logical decoding, and would rather not run a
  // container that can only report that. The server then has no realtime URL, which is what makes
  // subscription requests fail with a clear route error instead of hanging against a dead upstream.
  const realtime = realtimeEnabled(config)
  const realtimeBlock = realtime
    ? `  realtime:
    image: \${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:latest}
    expose:
      - "4000"
    environment:
      PORT: "4000"
      DATABASE_URL: "${ownerUrl}"
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is missing from .env}
      SLOT_NAME: supatype_realtime
      # Matches the publication the supatype/postgres image creates. Read by nothing today,
      # wal2json decodes from the slot, and kept for a future pgoutput decoder.
      PUBLICATION_NAME: supatype_realtime
${dbDependency}`
    : `  # No \`realtime\` service: database.external.realtime is false. Subscriptions are
  # unavailable; REST, storage, auth and functions are unaffected.
`
  const realtimeDependency = realtime
    ? `      realtime:
        condition: service_started
`
    : ""
  const realtimeServerEnv = realtime ? "      SUPATYPE_REALTIME_URL: http://realtime:4000" : ""

  const dbServiceBlock = external
    ? `  # No \`db\` service: database.external points this stack at a Postgres it does not manage.
  # Every service reads \${DATABASE_URL} from .env, and \`supatype db check\` reports what that
  # database still needs (roles, extensions, wal_level for realtime).
`
    : `  db:
    image: \${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-supatype_admin}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing from .env}
      POSTGRES_DB: \${POSTGRES_DB:-supatype}
      # Read by the image's init to password the \`authenticator\` role PostgREST connects as.
      AUTHENTICATOR_PASSWORD: \${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is missing from .env}
${dbPorts}    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      # -h 127.0.0.1 forces TCP. Without it \`pg_isready\` uses the Unix socket, which the
      # entrypoint's temporary init server is already listening on while TCP is still refused,
      # so the container reported healthy, \`depends_on: service_healthy\` released, and every
      # service that connects over the network died with ECONNREFUSED on first boot. PostgREST
      # survived only because it retries. Observed on a clean stack: server, storage and
      # realtime all exited 1 while db said "healthy".
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \${POSTGRES_USER:-supatype_admin} -d \${POSTGRES_DB:-supatype}"]
      interval: 5s
      timeout: 5s
      # First boot runs initdb plus every bootstrap migration. Failures inside the start period
      # do not count against retries, so a slow init waits rather than being declared unhealthy.
      start_period: 90s
      retries: 20

`

  return `# Generated by supatype self-host compose
# Kong → supatype-server (unified gateway) → internal PostgREST / storage / etc.
services:
${dbServiceBlock}  postgrest:
    image: postgrest/postgrest:v12.2.8
    expose:
      - "3000"
    environment:
      # Connects as \`authenticator\`, not \${POSTGRES_USER}, which is a superuser, and a
      # superuser session may SET ROLE to any role in the cluster, so a request whose JWT
      # named one got it. \`authenticator\` is NOINHERIT with membership in only
      # anon/authenticated/service_role, so the same SET ROLE is refused.
      #
      # Its own credential, not POSTGRES_PASSWORD: yours is for direct SQL access and
      # rotating it must not take the REST API down. \`supatype init\` generates this.
      PGRST_DB_URI: ${postgrestUrl}
      # Derived from schema.pg_schema (or schema.api_schemas). Hardcoding this is why choosing a
      # non-public pg_schema used to give a correct push and an API that answered PGRST106 for
      # everything: the engine moved and PostgREST was never told.
      PGRST_DB_SCHEMA: "${apiSchemaList(config, options?.fieldMaskingTier)}"
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is missing from .env}
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_POOL: 3
${dbDependency}
  storage:
    image: \${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}
    expose:
      - "5000"
    environment:
      PORT: 5000
      DATABASE_URL: "${ownerUrl}"
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is missing from .env}
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_ACCESS_KEY: supatype
      S3_SECRET_KEY: supatype-secret
      S3_FORCE_PATH_STYLE: "true"
${dbDependency}
  functions-worker:
    image: \${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-supatype/functions-worker:latest}
    expose:
      - "8001"
    volumes:
      - ${projectMount}:/project:ro
    environment:
      SUPATYPE_FUNCTIONS_ROOT: /project/functions
      SUPATYPE_DENO_FUNCTIONS_DIR: /project/functions
      # Model hooks, served by this same worker under a hooks/ route the gateway refuses from
      # outside. One worker rather than two: a second container would cost a pod per project on
      # cloud, for isolation the route boundary already provides.
      SUPATYPE_HOOKS_ROOT: /project/hooks
      PORT: "8001"
      # In-compose loopback to Kong (not API_EXTERNAL_URL / localhost, unreachable from this container).
      SUPATYPE_URL: http://kong:8000
      SUPATYPE_INTERNAL_URL: http://kong:8000
      SUPATYPE_ANON_KEY: \${ANON_KEY:-}
      # Present so the worker can hand it to hooks, which are procedural and unreachable from
      # outside: and to the public functions named below. Withheld from every other handler before
      # any of them is imported: a function is a public endpoint, and an ambient admin credential made
      # each one able to read past every access rule in the schema.
      SUPATYPE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY:-}
      SUPATYPE_SERVICE_ROLE_ROUTES: "${serviceRoleRoutes(config).join(",")}"
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY:-}
      STRIPE_WEBHOOK_SECRET: \${STRIPE_WEBHOOK_SECRET:-}
      SITE_URL: \${SITE_URL:-\${API_EXTERNAL_URL:-${externalUrlFallback}}}
${dbDependency}
${realtimeBlock}
  control-plane:
    image: \${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:latest}
    expose:
      - "8080"
    volumes:
      - ${projectMount}:/project
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      PORT: "8080"
      SUPATYPE_PROJECT_REF: ${JSON.stringify(config.project.name)}
      SUPATYPE_PROJECT_ROOT: /project
      DATABASE_URL: "${ownerUrl}"
      SUPATYPE_FUNCTIONS_ROOT: /project/functions
      SUPATYPE_STATIC_ROOT: /project/${staticDir.replace(/^\.\//, "")}
      SUPATYPE_DEPLOYMENTS_DIR: /project/.supatype/deployments
      COMPOSE_PROJECT_NAME: ${composeProject}
      SUPATYPE_ENGINE_BIN: supatype-engine
${dbDependency}
  server:
    image: \${SUPATYPE_SERVER_IMAGE:-\${SUPATYPE_AUTH_IMAGE:-supatype/server:latest}}
${serverPorts}    volumes:
      - ${projectMount}:/project:ro
    working_dir: /project
    environment:
      SUPATYPE_MODE: ${devLocal ? "dev" : "standalone"}
      SUPATYPE_MANIFEST_PATH: .supatype/manifest.json
      SUPATYPE_ADMIN_CONFIG_PATH: .supatype/admin-config.json
      SUPATYPE_API_CONFIG_PATH: .supatype/api-config.json
      SUPATYPE_POSTGREST_URL: http://postgrest:3000
      SUPATYPE_GRAPHQL_URL: http://postgrest:3000
      SUPATYPE_STORAGE_URL: http://storage:5000
      SUPATYPE_URL: \${API_EXTERNAL_URL:-${externalUrlFallback}}
      SUPATYPE_ANON_KEY: \${ANON_KEY:-}
      SUPATYPE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY:-}
      SUPATYPE_SQL_DATABASE_URL: "${ownerUrl}"
      SUPATYPE_DENO_FUNCTIONS_DIR: /project/functions
      SUPATYPE_FUNCTIONS_WORKER_URL: http://functions-worker:8001
${realtimeServerEnv}
      SUPATYPE_CONTROL_PLANE_URL: http://control-plane:8080
      SUPATYPE_VALKEY_ADDR: valkey:6379
${appEnv}
      SUPATYPE_API_HOST: 0.0.0.0
      SUPATYPE_API_PORT: 9999
      SUPATYPE_API_EXTERNAL_URL: \${API_EXTERNAL_URL:-${externalUrlFallback}}
      SUPATYPE_DB_DRIVER: postgres
      SUPATYPE_DB_DATABASE_URL: "${authUrl}${authSearchPathSeparator}search_path=auth"
      SUPATYPE_SITE_URL: \${SITE_URL:-${siteUrlFallback}}
      SUPATYPE_JWT_SECRET: \${JWT_SECRET:?JWT_SECRET is missing from .env}
      SUPATYPE_JWT_EXP: 3600
      SUPATYPE_JWT_AUD: authenticated
      SUPATYPE_JWT_DEFAULT_GROUP_NAME: authenticated
      SUPATYPE_JWT_ADMIN_ROLES: service_role,supatype_admin
      SUPATYPE_MAILER_AUTOCONFIRM: \${SUPATYPE_MAILER_AUTOCONFIRM:-true}
      # email.provider and email.smtp are config, and nothing used to carry
      # them here: with no provider and no SMTP host the auth service falls
      # through to its noop client, so every message was dropped in silence and
      # a project asking for smtp got the same nothing as one asking for console.
      # The name really is MAILER_MAILER: the field is Mailer.MailerProvider.
      SUPATYPE_MAILER_MAILER_PROVIDER: \${SUPATYPE_MAILER_MAILER_PROVIDER:-console}
      SUPATYPE_SMTP_HOST: \${SUPATYPE_SMTP_HOST:-}
      # 587, not empty: this one is an int on the server, and compose
      # substitutes an unset variable as "", which fails to parse and takes
      # the whole service down on boot. 587 is the server's own default, so
      # leaving it unset now behaves exactly as it would with no value at all.
      SUPATYPE_SMTP_PORT: \${SUPATYPE_SMTP_PORT:-587}
      SUPATYPE_SMTP_USER: \${SUPATYPE_SMTP_USER:-}
      SUPATYPE_SMTP_PASS: \${SUPATYPE_SMTP_PASS:-}
      SUPATYPE_SMTP_ADMIN_EMAIL: \${SUPATYPE_SMTP_ADMIN_EMAIL:-}
      SUPATYPE_SMTP_SENDER_NAME: \${SUPATYPE_SMTP_SENDER_NAME:-}
      SUPATYPE_DISABLE_SIGNUP: \${DISABLE_SIGNUP:-false}
${devLocal ? "      STUDIO_OPEN_DEV: \"1\"\n" : ""}
    depends_on:
${dbDependencyClause}      valkey:
        condition: service_started
      postgrest:
        condition: service_started
      storage:
        condition: service_started
      functions-worker:
        condition: service_started
${realtimeDependency}      control-plane:
        condition: service_started

  minio:
    image: minio/minio:RELEASE.2024-11-07T00-52-20Z
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: supatype
      MINIO_ROOT_PASSWORD: supatype-secret
${minioPorts}    volumes:
      - minio-data:/data

  schema-engine:
    image: \${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:latest}
    profiles: ["tools"]
    entrypoint: ["supatype-engine"]
    volumes:
      - ${projectMount}:/project
    working_dir: /project
${dbDependency}${studioBlock}${valkeyBlock}${tlsHintComment}  kong:
    image: kong:3.6
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /etc/kong/kong.yml
      KONG_PROXY_ACCESS_LOG: /dev/stdout
      KONG_ADMIN_ACCESS_LOG: /dev/stdout
      KONG_PROXY_ERROR_LOG: /dev/stderr
      KONG_ADMIN_ERROR_LOG: /dev/stderr
${kongTlsEnv}    volumes:
      - ${kongMount}:/etc/kong/kong.yml:ro
    ports:
${kongPorts}
    depends_on:
${kongDependsOn}${kongValkeyDepends}

${volumesBlock}`
}

/** In-compose worker address: matches the `functions-worker` service this file always generates. */
const COMPOSE_FUNCTIONS_WORKER_URL = "http://functions-worker:8001"

function ensureComposeManifest(cwd: string, config: SupatypeProjectConfig): void {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  mkdirSync(dirname(manifestPath), { recursive: true })

  // The manifest is generated, not operator-authored, but `push` writes real values into it (the
  // schema, for one), so an existing file is repaired rather than replaced.
  if (existsSync(manifestPath)) {
    repairComposeFunctionsFlag(manifestPath)
    return
  }

  const manifest = {
    schema: "public",
    postgrest_url: "http://postgrest:3000",
    storage_url: "http://storage:5000",
    // Matches the compose file: a manifest advertising a service that was not generated is how
    // the server ends up proxying subscriptions to a host that does not resolve.
    realtime_enabled: realtimeEnabled(config),
    ...(realtimeEnabled(config) && { realtime_url: "http://realtime:4000" }),
    // True because this file *always* generates a `functions-worker` service and hands the server
    // `SUPATYPE_FUNCTIONS_WORKER_URL`. It said false, so the server answered 404 for every function
    // in a stack that was running a worker for them, provisioned, then switched off.
    functions_enabled: true,
    functions_worker_url: COMPOSE_FUNCTIONS_WORKER_URL,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

/**
 * Turn functions on in a manifest written by an older CLI, leaving every other key alone.
 *
 * Without this, only new projects get working functions: a stack generated before the flag was
 * corrected keeps `functions_enabled: false` on disk, and regenerating the compose file, the
 * obvious thing to try, does not fix it.
 */
function repairComposeFunctionsFlag(manifestPath: string): void {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  } catch {
    return // Malformed: leave it for the server to complain about rather than overwrite it here.
  }
  if (typeof parsed !== "object" || parsed === null) return
  if (parsed["functions_enabled"] === true && parsed["functions_worker_url"] !== undefined) return

  parsed["functions_enabled"] = true
  if (parsed["functions_worker_url"] === undefined) {
    parsed["functions_worker_url"] = COMPOSE_FUNCTIONS_WORKER_URL
  }
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

function ensureProjectFunctionsDir(cwd: string, config: SupatypeProjectConfig): void {
  mkdirSync(preferredFunctionsPathFromProject(config, cwd), { recursive: true })
  // Both roots must exist before compose mounts the project read-only: a missing directory becomes
  // a bind mount of a file that is not there, and the worker fails to start rather than serving the
  // half it does have.
  mkdirSync(hooksPathFromProject(config, cwd), { recursive: true })
}

/**
 * The config's external URL and `.env`'s `DATABASE_URL` must be the same string.
 *
 * The CLI resolves the URL from config; Compose substitutes `.env` at up-time. If the two disagree,
 * `push` migrates one database while the services serve another, which reads as data loss and
 * isn't. It also makes the generated auth DSN wrong, since whether to append `search_path` with
 * `?` or `&` is decided from the config URL's query string.
 */
function assertExternalUrlMatchesEnv(cwd: string, config: SupatypeProjectConfig): void {
  const configured = externalDatabaseUrl(config)
  if (configured === undefined) return

  const fromEnv = readEnvFile(cwd)["DATABASE_URL"]
  if (fromEnv === undefined) {
    // Nothing to disagree with. Compose's own `:?` guard reports this at up-time, and the operator
    // may be exporting the variable in their shell rather than keeping a file.
    return
  }
  if (fromEnv.trim() === configured) return

  fatalError(
    "DATABASE_URL in .env does not match database.external.url",
    [
      `.env:    ${fromEnv.trim()}`,
      `config:  ${configured}`,
      "",
      "The CLI connects using the config value and the stack connects using .env, so a push would",
      "land in one database while the services serve the other.",
      "Point the config at the same variable to keep them in step:",
      "  database: { external: { url: process.env.DATABASE_URL! } }",
    ],
    { brand: { intro: "Self-host compose" } },
  )
}

/**
 * A loopback host in the external URL cannot work from inside a container.
 *
 * `127.0.0.1` means "this container" to every service in the stack, so an external database on the
 * host machine is unreachable, while the *CLI* reaches it fine, because the CLI runs on the host.
 * That asymmetry is the trap: `supatype db check` passes, `push` applies the schema, and then
 * storage, realtime and the server all die with ECONNREFUSED against their own loopback. Found by
 * rehearsing exactly that.
 *
 * Refused rather than rewritten. The compose file interpolates one `${DATABASE_URL}` for every
 * service, so silently substituting a different host would mean the CLI and the stack no longer
 * agree about which database they are talking to, the thing every other check here exists to
 * prevent.
 */
export function loopbackExternalHost(config: SupatypeProjectConfig): string | undefined {
  const url = externalDatabaseUrl(config)
  if (url === undefined) return undefined

  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined // Shape is validated at config load; nothing useful to add here.
  }
  // Node strips the brackets from an IPv6 hostname, and 127.0.0.0/8 is all loopback.
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  return loopback ? host : undefined
}

function assertExternalUrlReachableFromContainers(config: SupatypeProjectConfig): void {
  const host = loopbackExternalHost(config)
  if (host === undefined) return

  fatalError(
    `database.external.url points at ${host}, which no container can reach`,
    [
      "Inside a container, localhost is that container, not the machine running Docker. Every",
      "service in the stack would fail to connect, while the CLI succeeds because it runs on the host.",
      "",
      "Use a host the containers can resolve:",
      "  host.docker.internal   (Docker Desktop on macOS and Windows)",
      "  172.17.0.1             (the docker0 bridge on Linux, or add an extra_hosts entry)",
      "  the database's LAN address or hostname",
      "",
      "The CLI reaches the same address, so one value keeps working for both.",
    ],
    { brand: { intro: "Self-host compose" } },
  )
}

/**
 * The tier to write into the compose file.
 *
 * Resolved here so every caller gets it, rather than threaded through four call sites that load the
 * schema a moment later anyway. A schema that fails to load falls back to the default list: compose
 * generation is the wrong place to report a syntax error, and `push`/`dev` do it properly seconds
 * later with the file and line.
 */
function resolveFieldMaskingTier(
  cwd: string,
  config: SupatypeProjectConfig,
  options?: SelfHostComposeOptions,
): FieldMaskingTier | undefined {
  if (options?.fieldMaskingTier !== undefined) return options.fieldMaskingTier
  return fieldMaskingTierFromProject(cwd, config)
}

export function writeSelfHostCompose(
  cwd: string,
  config: SupatypeProjectConfig,
  options?: SelfHostComposeOptions,
): SelfHostComposePaths {
  assertExternalUrlMatchesEnv(cwd, config)
  const tier = resolveFieldMaskingTier(cwd, config, options)
  const resolved: SelfHostComposeOptions = {
    ...options,
    ...(tier !== undefined && { fieldMaskingTier: tier }),
  }
  assertExternalUrlReachableFromContainers(config)
  const paths = selfHostComposePaths(cwd)
  mkdirSync(paths.dir, { recursive: true })
  ensureProjectFunctionsDir(cwd, config)
  ensureComposeManifest(cwd, config)
  writeFileSync(paths.composePath, renderSelfHostCompose(config, cwd, resolved), "utf8")
  const studioHostDev = options?.devLocal === true && hasStudioOverride(config)
  const tlsEnabled = selfHostTlsEnabled(config, options?.devLocal === true)
  const domain = config.server.domain?.trim()
  const acmeEmail = config.server.tls?.email?.trim()
  writeFileSync(
    paths.kongPath,
    buildKongDeclarative({
      unifiedGateway: true,
      ...(studioHostDev && {
        studioServiceUrl: COMPOSE_STUDIO_HOST_URL,
        studioStripPath: false,
      }),
      ...(tlsEnabled && domain && acmeEmail
        ? { acme: { email: acmeEmail, domain, redisHost: "valkey" } }
        : {}),
    }),
    "utf8",
  )
  return paths
}

export interface RunDockerComposeOptions {
  /** Suppress docker compose progress UI (container status lines). */
  quiet?: boolean
  /** Logo + Clack intro when Docker preflight fails (TTY). */
  brand?: DockerBrandOptions
}

/** Exit with a friendly compose failure message. */
export function exitComposeFailed(
  status: number,
  context: string,
  brand?: DockerBrandOptions,
): never {
  fatalError(
    `docker compose failed (exit ${status}).`,
    [context, "Check logs: supatype self-host compose logs"],
    { ...(brand !== undefined && { brand }), exitCode: status === 0 ? 1 : status },
  )
}

export function runDockerCompose(
  composePath: string,
  args: string[],
  projectRoot: string = process.cwd(),
  composeProject?: string,
  options?: RunDockerComposeOptions,
): number {
  requireDockerDaemon(options?.brand !== undefined ? { brand: options.brand } : undefined)
  const envFile = resolve(projectRoot, ".env")
  const composeArgs = ["compose"]
  if (options?.quiet) {
    composeArgs.push("--progress", "quiet")
  }
  // Per-project name isolates containers/volumes/network so multiple Supatype
  // projects on one machine never share a database (default would be the
  // ".supatype/self-host" dir name, identical for every project).
  if (composeProject) composeArgs.push("-p", composeProject)
  // Resolve ${VAR} in compose.yml from the project root .env (not .supatype/self-host/).
  composeArgs.push("--project-directory", projectRoot)
  composeArgs.push("-f", composePath)
  if (existsSync(envFile)) {
    composeArgs.push("--env-file", envFile)
  }
  composeArgs.push(...args)
  const env: NodeJS.ProcessEnv = options?.quiet
    ? { ...process.env, COMPOSE_PROGRESS: "quiet" }
    : process.env
  const stdio = options?.quiet ? "pipe" : "inherit"
  const result = spawnSync("docker", composeArgs, {
    stdio,
    cwd: projectRoot,
    env,
    ...(options?.quiet ? { encoding: "utf8" as const } : {}),
  })
  if (options?.quiet && result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .join("\n")
      .trim()
    if (detail) {
      console.error(`[supatype] docker compose: ${detail}`)
    }
  }
  return result.status ?? 1
}

/** Compose project name for a Supatype project, isolates docker state per project. */
export function composeProjectName(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `supatype-${slug || "project"}`
}
