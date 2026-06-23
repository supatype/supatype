import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { preferredFunctionsPathFromProject, selfHostTlsEnabled, type SupatypeProjectConfig } from "./project-config.js"
import { hasEngineOverride, hasStudioOverride, pinnedVersion, fetchLatestVersion, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { buildKongDeclarative } from "./kong-config.js"

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
 * Does not touch `.env` — server/postgres still use compose `:latest` defaults.
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
 * not from the compose file directory — use `.` not `../..`.
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

/** Host Vite dev server as seen from Kong inside Docker Compose. */
export const COMPOSE_STUDIO_HOST_URL = "http://host.docker.internal:3002"

/** Studio container — always Docker Hub unless SUPATYPE_STUDIO_IMAGE is set in .env. */
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
  return lines.join("\n")
}

export interface SelfHostComposeOptions {
  /** `supatype dev` with provider docker: internal-only db/server; Kong on host :18473. */
  devLocal?: boolean
}

export function renderSelfHostCompose(
  config: SupatypeProjectConfig,
  cwd: string = process.cwd(),
  options?: SelfHostComposeOptions,
): string {
  const projectMount = projectMountPath(cwd)
  const kongMount = kongMountPath(cwd)
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
`
    : ""
  const kongPorts = tlsEnabled
    ? `      - "80:8000"
      - "443:8443"`
    : `      - "\${SUPATYPE_KONG_PORT:-18473}:8000"`
  const kongTlsDependsOn = tlsEnabled ? "\n      - valkey" : ""
  const valkeyBlock = tlsEnabled
    ? `
  valkey:
    image: \${SUPATYPE_VALKEY_IMAGE:-valkey/valkey:8-alpine}
    command: ["valkey-server", "--appendonly", "yes"]
    expose:
      - "6379"
    volumes:
      - valkey-data:/data
`
    : ""
  const tlsHintComment = tlsEnabled
    ? ""
    : `  # HTTPS is off. To enable automatic TLS (Let's Encrypt) for production, set in supatype.config.ts:
  #   server: { mode: "standalone", domain: "your.domain", tls: { email: "you@example.com" } }
  # then re-run \`supatype self-host compose up -d\`. Kong publishes :80/:443 and provisions certs automatically.
`
  const volumesBlock = tlsEnabled
    ? `volumes:
  db-data:
  minio-data:
  valkey-data:
`
    : `volumes:
  db-data:
  minio-data:
`

  return `# Generated by supatype self-host compose
# Kong → supatype-server (unified gateway) → internal PostgREST / storage / etc.
services:
  db:
    image: \${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-supatype_admin}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${POSTGRES_DB:-supatype}
${dbPorts}    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-supatype_admin}"]
      interval: 5s
      timeout: 5s
      retries: 20

  postgrest:
    image: postgrest/postgrest:v12.2.8
    expose:
      - "3000"
    environment:
      PGRST_DB_URI: postgresql://\${POSTGRES_USER:-supatype_admin}:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-supatype}
      PGRST_DB_SCHEMA: "public, supatype, graphql_public, auth"
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_POOL: 3
    depends_on:
      db:
        condition: service_healthy

  storage:
    image: \${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}
    expose:
      - "5000"
    environment:
      PORT: 5000
      DATABASE_URL: "postgresql://\${POSTGRES_USER:-supatype_admin}:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-supatype}"
      JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_ACCESS_KEY: supatype
      S3_SECRET_KEY: supatype-secret
      S3_FORCE_PATH_STYLE: "true"
    depends_on:
      db:
        condition: service_healthy

  functions-worker:
    image: \${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-supatype/functions-worker:latest}
    expose:
      - "8001"
    volumes:
      - ${projectMount}:/project:ro
    environment:
      SUPATYPE_FUNCTIONS_ROOT: /project/functions
      SUPATYPE_DENO_FUNCTIONS_DIR: /project/functions
      PORT: "8001"
      SUPATYPE_URL: \${API_EXTERNAL_URL:-${externalUrlFallback}}
      SUPATYPE_ANON_KEY: \${ANON_KEY:-}
      SUPATYPE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY:-}
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY:-}
      STRIPE_WEBHOOK_SECRET: \${STRIPE_WEBHOOK_SECRET:-}
      SITE_URL: \${SITE_URL:-\${API_EXTERNAL_URL:-${externalUrlFallback}}}
    depends_on:
      db:
        condition: service_healthy

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
      DATABASE_URL: "postgresql://\${POSTGRES_USER:-supatype_admin}:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-supatype}"
      SUPATYPE_FUNCTIONS_ROOT: /project/functions
      SUPATYPE_STATIC_ROOT: /project/${staticDir.replace(/^\.\//, "")}
      SUPATYPE_DEPLOYMENTS_DIR: /project/.supatype/deployments
      COMPOSE_PROJECT_NAME: ${composeProject}
      SUPATYPE_ENGINE_BIN: supatype-engine
    depends_on:
      db:
        condition: service_healthy

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
      SUPATYPE_SQL_DATABASE_URL: "postgresql://\${POSTGRES_USER:-supatype_admin}:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-supatype}"
      SUPATYPE_DENO_FUNCTIONS_DIR: /project/functions
      SUPATYPE_FUNCTIONS_WORKER_URL: http://functions-worker:8001
      SUPATYPE_CONTROL_PLANE_URL: http://control-plane:8080
${appEnv}
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: \${API_EXTERNAL_URL:-${externalUrlFallback}}
      GOTRUE_API_EXTERNAL_URL: \${API_EXTERNAL_URL:-${externalUrlFallback}}
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: "postgres://\${POSTGRES_USER:-supatype_admin}:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-supatype}?search_path=auth"
      GOTRUE_SITE_URL: \${SITE_URL:-${siteUrlFallback}}
      GOTRUE_JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_ADMIN_ROLES: service_role,supatype_admin
      GOTRUE_MAILER_AUTOCONFIRM: \${GOTRUE_MAILER_AUTOCONFIRM:-true}
      GOTRUE_DISABLE_SIGNUP: \${DISABLE_SIGNUP:-false}
${devLocal ? "      STUDIO_OPEN_DEV: \"1\"\n" : ""}
    depends_on:
      db:
        condition: service_healthy
      postgrest:
        condition: service_started
      storage:
        condition: service_started
      functions-worker:
        condition: service_started
      control-plane:
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
    depends_on:
      db:
        condition: service_healthy
${studioBlock}${valkeyBlock}${tlsHintComment}  kong:
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
${kongDependsOn}${kongTlsDependsOn}

${volumesBlock}`
}

function ensureComposeManifest(cwd: string): void {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  if (existsSync(manifestPath)) return
  mkdirSync(dirname(manifestPath), { recursive: true })
  const manifest = {
    schema: "public",
    postgrest_url: "http://postgrest:3000",
    storage_url: "http://storage:5000",
    realtime_enabled: true,
    functions_enabled: false,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

function ensureProjectFunctionsDir(cwd: string, config: SupatypeProjectConfig): void {
  mkdirSync(preferredFunctionsPathFromProject(config, cwd), { recursive: true })
}

export function writeSelfHostCompose(
  cwd: string,
  config: SupatypeProjectConfig,
  options?: SelfHostComposeOptions,
): SelfHostComposePaths {
  const paths = selfHostComposePaths(cwd)
  mkdirSync(paths.dir, { recursive: true })
  ensureProjectFunctionsDir(cwd, config)
  ensureComposeManifest(cwd)
  writeFileSync(paths.composePath, renderSelfHostCompose(config, cwd, options), "utf8")
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
}

export function runDockerCompose(
  composePath: string,
  args: string[],
  projectRoot: string = process.cwd(),
  composeProject?: string,
  options?: RunDockerComposeOptions,
): number {
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
  const result = spawnSync("docker", composeArgs, { stdio: "inherit", cwd: projectRoot, env })
  return result.status ?? 1
}

/** Compose project name for a Supatype project — isolates docker state per project. */
export function composeProjectName(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `supatype-${slug || "project"}`
}
