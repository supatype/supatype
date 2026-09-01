/**
 * `supatype dev` when `provider: docker`, full self-host Compose stack (Kong gateway).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { startProxyDevApp, resolveProxyDevScript } from "./app/proxy-dev-app.js"
import { loadSchemaAst } from "./config.js"
import { withComposeSchemaPushLock } from "./schema-push-lock.js"
import {
  COMPOSE_DEV_KONG_PORT,
  connectionString,
  projectRootFromConfig,
  resolveRuntimeProvider,
  hooksPathFromProject,
  schemaPathFromProject,
  usesExternalDatabase,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { syncManifestHooks, writeHooksModule } from "./model-hooks.js"
import { signJwt } from "./jwt.js"
import { ensureDevDbPort, ensureKongPort } from "./dev-ports.js"
import { handleComposeProjectRename } from "./compose-rename.js"
import { recoverStaleDevSession, writeDevSessionLock } from "./dev-session-lock.js"
import { endDevSession, startDevSession } from "./dev-session.js"
import { ensureDevApiConfig } from "./ensure-dev-api-config.js"
import {
  COMPOSE_PINNED_IMAGE_ENV_KEYS,
  composeDockerImageEnv,
  composeProjectName,
  exitComposeFailed,
  runDockerCompose,
  schemaEngineImageForPush,
  writeSelfHostCompose,
  type SelfHostComposePaths,
} from "./self-host-compose.js"
import type { DockerBrandOptions } from "./docker-runtime.js"
import { hasEngineOverride } from "./binary-cache.js"
import { STUDIO_DEV_PORT, startStudioViteDevServer } from "./studio-dev-server.js"
import {
  ensureLocalServerDockerImage,
  usesLocalServerImage,
  LOCAL_SERVER_DOCKER_IMAGE,
} from "./compose-local-server-image.js"
import { ensureEngine, engineRequest, type DiffResult } from "./engine-client.js"
import { writeSchemaSourcePushArtifacts, type SchemaSourcePushArtifacts } from "./schema-sources.js"
import { readEnvValue, upsertEnvFile } from "./env-file.js"
import {
  devAuthenticatorPassword,
  devJwtSecret,
  devPostgresPassword,
  seedMissingDatabaseIdentity,
  seedMissingLocalSecrets,
} from "./local-secrets.js"
import { writeLocalEnvironment } from "./link.js"
import { registerDevShutdown } from "./dev-shutdown.js"
import {
  filterComposeNoise,
  formatEnginePushMessage,
  parseEngineJsonOutput,
  parseEnginePushOutput,
} from "./engine-push-output.js"
import { withAdminRoles } from "./studio-admin-roles.js"
import { restoreSystemRelationTargets } from "./restore-system-relation-targets.js"
import { provisionBucketsFromAst } from "./storage-provision.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"
import { ensureFirstAdminUserForProject } from "./commands/admin.js"
import { publishDevReady } from "./dev-ready-panel.js"

/** Default host port for compose Postgres when `overrides.engine` is set (devLocal). */
const COMPOSE_DEV_DB_PORT = 54329

/** Sync optional Docker image pins from config into `.env` (no JWT rotation). */
export function syncComposeImagePins(cwd: string, config: SupatypeProjectConfig): void {
  const imagePins = composeDockerImageEnv(config)
  // Clean up only what a previous run wrote from config. A hand-written image tag in `.env` is the
  // documented way to run a local build, and this used to delete it on every compose run.
  const removeImageKeys = COMPOSE_PINNED_IMAGE_ENV_KEYS.filter((key) => !(key in imagePins))
  upsertEnvFile(cwd, imagePins, {
    removeManaged: removeImageKeys,
    managed: COMPOSE_PINNED_IMAGE_ENV_KEYS,
  })
}

export interface DevComposeOptions {
  watch: boolean
}

/** In-compose Postgres URL (SCRAM; not published to the host). */
export function composeDbUrl(cwd: string): string {
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  return `postgresql://${user}:${devPostgresPassword(cwd)}@db:5432/${db}?sslmode=disable`
}

/**
 * Resolve the host Kong port for this project. Persisted in `.env` as
 * SUPATYPE_KONG_PORT; prompts when the configured port is already taken.
 */
async function resolveDevDbPort(cwd: string): Promise<number> {
  return ensureDevDbPort(cwd)
}

/**
 * The database URL to hand a tool, from wherever it happens to run.
 *
 * The compose helpers below describe the `db` *container*, on the host at
 * `SUPATYPE_DEV_DB_PORT`, or in-network at `db:5432`. Neither exists for a project pointed at an
 * external database, and passing one produced "pool timed out while waiting for an open connection"
 *- a message with nothing in it about the URL being wrong.
 */
function projectDatabaseUrl(cwd: string, config: SupatypeProjectConfig, inNetwork = false): string {
  if (usesExternalDatabase(config)) return connectionString(config)
  return inNetwork ? composeDbUrl(cwd) : hostComposeDbUrl(cwd)
}

function hostComposeDbUrl(cwd: string): string {
  const port = readEnvValue(cwd, "SUPATYPE_DEV_DB_PORT", String(COMPOSE_DEV_DB_PORT))
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const pass = devPostgresPassword(cwd)
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  return `postgresql://${user}:${pass}@127.0.0.1:${port}/${db}?sslmode=disable`
}

/**
 * When `provider: docker` and `overrides.engine` is set, ensure Postgres is published
 * on the host (SUPATYPE_DEV_DB_PORT) so the local engine binary can connect.
 */
export async function ensureDockerDbPublishedForHostEngine(
  cwd: string,
  config: SupatypeProjectConfig,
  brand?: DockerBrandOptions,
): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("ensureDockerDbPublishedForHostEngine requires provider: docker")
  }
  if (!hasEngineOverride(config)) {
    throw new Error(
      "Docker Postgres is not published to the host without overrides.engine. " +
        "Set overrides.engine in supatype.local.config.ts or pass --connection.",
    )
  }

  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd, project)
  const devDbPort = await resolveDevDbPort(cwd)

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, devJwtSecret(cwd))
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, devJwtSecret(cwd))
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
  await startComposeDatabase(config, paths, cwd, project, brand)
}

/**
 * True when CLI should publish local Compose Postgres for the host-side engine
 * (local dev with overrides.engine). False for remote DB URLs via config or --connection.
 */
export function usesLocalDockerEngineDb(
  config: SupatypeProjectConfig,
  explicitConnection?: string,
): boolean {
  if (explicitConnection?.trim()) return false
  if (config.connection?.trim()) return false
  // An external database is already reachable and is not ours to publish. Without this the engine
  // path tried `compose up -d db` against a compose file that deliberately has no `db` service.
  if (usesExternalDatabase(config)) return false
  return resolveRuntimeProvider(config) === "docker" && hasEngineOverride(config)
}

/**
 * Resolve a Postgres URL reachable from the host-side engine binary.
 * Local docker + overrides.engine → SUPATYPE_DEV_DB_PORT on localhost.
 * Remote self-host → set `connection` in config or pass `--connection`.
 */
export async function resolveHostEngineDatabaseUrl(
  cwd: string,
  config: SupatypeProjectConfig,
  explicit?: string,
): Promise<string> {
  if (explicit?.trim()) return explicit
  if (config.connection?.trim()) return config.connection
  if (usesLocalDockerEngineDb(config)) {
    await ensureDockerDbPublishedForHostEngine(cwd, config)
    return hostComposeDbUrl(cwd)
  }
  return connectionString(config)
}

/**
 * `email.provider` and `email.smtp` for the compose server service.
 *
 * The native dev path has mapped these since it existed; the compose path never
 * did, so a project that asked for smtp got the auth service's noop client and
 * no message at all. Console is the documented default, and it at least says
 * that a message would have been sent.
 */
function composeMailerEnv(config: SupatypeProjectConfig): Record<string, string> {
  const email = config.email
  const out: Record<string, string> = {
    // Mailer.MailerProvider, so the doubled word is the real name.
    SUPATYPE_MAILER_MAILER_PROVIDER: email?.provider ?? "console",
  }
  const smtp = email?.smtp
  if (email?.provider !== "smtp" || smtp === undefined) return out

  if (smtp.host !== undefined && smtp.host !== "") out.SUPATYPE_SMTP_HOST = smtp.host
  if (smtp.port !== undefined) out.SUPATYPE_SMTP_PORT = String(smtp.port)
  if (smtp.user !== undefined && smtp.user !== "") out.SUPATYPE_SMTP_USER = smtp.user
  if (smtp.pass !== undefined && smtp.pass !== "") out.SUPATYPE_SMTP_PASS = smtp.pass
  if (smtp.admin_email !== undefined && smtp.admin_email !== "") {
    out.SUPATYPE_SMTP_ADMIN_EMAIL = smtp.admin_email
  }
  if (smtp.sender_name !== undefined && smtp.sender_name !== "") {
    out.SUPATYPE_SMTP_SENDER_NAME = smtp.sender_name
  }
  return out
}

async function resolveKongPort(cwd: string, composeProject?: string): Promise<number> {
  // The compose project is passed so an already-running stack of *this* project counts as
  // available rather than as a collision.
  return ensureKongPort(cwd, { context: "dev", ...(composeProject !== undefined && { composeProject }) })
}

/**
 * Bring up the compose `db` service and wait for it to answer.
 *
 * A no-op when the project uses an external database: there is no such service, the database is
 * already running, and its readiness is the operator's, `supatype db check` is what reports on it.
 * Four call sites did this inline, so an external project hit `compose up -d db` against a compose
 * file that deliberately has no `db`.
 */
async function startComposeDatabase(
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  cwd: string,
  project: string,
  brand: DockerBrandOptions | undefined,
  timeoutMs = 120_000,
  onFailure?: () => void,
): Promise<void> {
  if (usesExternalDatabase(config)) return

  const up = runDockerCompose(paths.composePath, ["up", "-d", "db"], cwd, project, {
    quiet: true,
    ...(brand !== undefined && { brand }),
  })
  if (up !== 0) {
    onFailure?.()
    exitComposeFailed(up, "Could not start Postgres (compose db service).", brand)
  }
  await waitComposeHealthy(paths, cwd, timeoutMs, project)
}

export function upsertDevComposeEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  anonKey: string,
  serviceRoleKey: string,
  kongPort: number,
  devDbPort?: number,
): void {
  const apiUrl = `http://localhost:${kongPort}`
  const imagePins = composeDockerImageEnv(config)
  // `POSTGRES_PASSWORD` and `JWT_SECRET` are deliberately absent.
  //
  // They used to be pinned here to published constants on every `dev` run, against the same
  // `.env` a self-host deployment reads, so a project could not hold its own secrets, and one
  // `dev` after generating them put the published values back with nothing to show it. They are
  // now resolved from `.env` (see `local-secrets.ts`) and written by `init` alone.
  //
  // The keys below still have to be written, because they are *derived*: the anon and
  // service-role tokens are signed with the effective secret, so leaving a stale pair in place
  // would desync them from the secret that validates them.
  const updates: Record<string, string> = {
    // The docker dev path renders the *self-host* compose file, where the secrets have no
    // defaults: an unset value is a hard compose error rather than a service quietly starting
    // with a published constant. This guarantees presence without overwriting: only keys
    // genuinely absent from `.env` are filled, and with the value the project has been running
    // with rather than a fresh one.
    ...seedMissingLocalSecrets(cwd),
    // Project configuration, seeded not overwritten, see seedMissingDatabaseIdentity.
    ...seedMissingDatabaseIdentity(cwd),
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    VITE_SUPATYPE_ANON_KEY: anonKey,
    EXPO_PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    PUBLIC_SUPATYPE_URL: apiUrl,
    EXPO_PUBLIC_SUPATYPE_URL: apiUrl,
    SUPATYPE_KONG_PORT: String(kongPort),
    API_EXTERNAL_URL: apiUrl,
    SITE_URL: apiUrl,
    SUPATYPE_MAILER_AUTOCONFIRM: "true",
    ...composeMailerEnv(config),
    ...imagePins,
  }
  // Never for an external database: this URL describes the `db` container, which that project does
  // not have. Writing it overwrote the operator's own DATABASE_URL, the value the whole stack and
  // every CLI command reads, with a DSN pointing at a database that does not exist. Found by
  // rehearsing a push against a real external Postgres, where the compose guard then refused to
  // proceed because .env and the config disagreed. They disagreed because of this line.
  if (devDbPort !== undefined && !usesExternalDatabase(config)) {
    updates.SUPATYPE_DEV_DB_PORT = String(devDbPort)
    // User and database from the project, not hardcoded, same reason as
    // `seedMissingDatabaseIdentity`: a project not named "supatype" had this URL pointing at a
    // database that does not exist.
    const dbUser = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
    const dbName = readEnvValue(cwd, "POSTGRES_DB", "supatype")
    updates.DATABASE_URL =
      `postgresql://${dbUser}:${devPostgresPassword(cwd)}@localhost:${devDbPort}/${dbName}?sslmode=disable`
  }
  // `SUPATYPE_SERVER_IMAGE` is written here, not passed in, and it is deliberately *not* marked
  // managed. The managed marker means "this value came from `versions` in the config and is mine to
  // clean up when the pin goes away". The locally built image comes from `overrides`, so removing
  // it as an unpinned managed key was wrong: any `.env` write that did not know about the local
  // image deleted it, and compose then recreated the server from the published image.
  const wantsLocalServer = usesLocalServerImage(cwd, config)
  if (wantsLocalServer) updates.SUPATYPE_SERVER_IMAGE = LOCAL_SERVER_DOCKER_IMAGE

  const managedImageKeys = COMPOSE_PINNED_IMAGE_ENV_KEYS.filter(
    (key) => !(wantsLocalServer && key === "SUPATYPE_SERVER_IMAGE"),
  )
  const removeImageKeys = managedImageKeys.filter((key) => !(key in imagePins))
  upsertEnvFile(cwd, updates, {
    removeManaged: removeImageKeys,
    managed: managedImageKeys,
    // A local image left in `.env` after the project stopped asking for one would keep pointing
    // compose at a stale build, and it carries no marker for `removeManaged` to act on.
    ...(!wantsLocalServer &&
      !("SUPATYPE_SERVER_IMAGE" in imagePins) && { remove: ["SUPATYPE_SERVER_IMAGE"] }),
  })
}

/** Keep compose + Studio on the same freshly signed dev JWTs; sync optional image pins from config. */
function ensureDevComposeEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  anonKey: string,
  serviceRoleKey: string,
  kongPort: number,
  devDbPort?: number,
): void {
  upsertDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)
}

async function waitComposeHealthy(paths: SelfHostComposePaths, cwd: string, maxMs: number, composeProject: string): Promise<void> {
  const composeDir = dirname(paths.composePath)
  const envFile = join(cwd, ".env")
  const baseArgs = ["compose", "-p", composeProject, "-f", paths.composePath]
  if (existsSync(envFile)) baseArgs.push("--env-file", envFile)

  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const ready = spawnSync(
      "docker",
      [...baseArgs, "exec", "-T", "db", "pg_isready", "-U", "supatype_admin"],
      { cwd: composeDir, encoding: "utf8" },
    )
    if (ready.status === 0) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("Compose db service did not become healthy in time")
}

/** True when the named compose service has a running container. */
function composeServiceIsRunning(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  service: string,
): boolean {
  const envFile = join(cwd, ".env")
  const args = ["compose", "-p", composeProject, "--project-directory", cwd, "-f", paths.composePath]
  if (existsSync(envFile)) args.push("--env-file", envFile)
  args.push("ps", "-q", "--status", "running", service)
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" })
  return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim() !== ""
}

/**
 * Capture Postgres container logs before compose down destroys them.
 * Writes `.supatype/ci-logs/db-*.log` and prints a tail for CI job logs.
 */
function dumpComposeDbLogs(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  reason: string,
): void {
  const logDir = join(cwd, ".supatype", "ci-logs")
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const logPath = join(logDir, `db-${stamp}.log`)

  const envFile = join(cwd, ".env")
  const args = ["compose", "-p", composeProject, "--project-directory", cwd, "-f", paths.composePath]
  if (existsSync(envFile)) args.push("--env-file", envFile)
  args.push("logs", "--no-color", "--timestamps", "--tail", "800", "db")

  const result = spawnSync("docker", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  const body = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  const content = body || `(empty, docker compose logs db exit ${result.status ?? "?"})\n`
  try {
    writeFileSync(logPath, content)
  } catch {
    /* best-effort */
  }

  const lines = content.split("\n")
  const tail = lines.slice(-200).join("\n")
  console.error(`[supatype] Postgres logs after ${reason} (saved ${logPath}):`)
  console.error(tail)
}

/**
 * The gateway as the CLI reaches it, over IPv4.
 *
 * Not `localhost`. Docker publishes on `0.0.0.0`, so the IPv4 address is the one that is certainly
 * bound, while `localhost` resolves to `::1` first on Windows and macOS. Docker Desktop does forward
 * IPv6 through a relay, and when that relay is unhealthy it accepts the connection and then never
 * answers, so every readiness poll hangs rather than failing.
 *
 * The URLs written to `.env` and printed for the operator stay on `localhost`: those are for a
 * browser, where the name is the friendlier thing to see and the browser will fall back on its own.
 */
function loopbackBase(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * `fetch` with a deadline, because the built-in has none.
 *
 * A poll loop bounded by `maxSec` iterations is only bounded if each attempt can end. Against a
 * socket that accepts and never responds, an un-timed `fetch` never settles, the loop never reaches
 * its second iteration, and a wait advertised as 120 seconds runs until someone kills it. That is
 * how `supatype push` came to hang indefinitely after reporting the schema applied.
 */
async function fetchWithin(url: string, ms: number, init?: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}

async function waitKongReady(kongPort: number, maxSec: number): Promise<void> {
  const base = loopbackBase(kongPort)
  // Remembered so the failure can name the unhealthy upstream. Blaming "the
  // Kong gateway" sent more than one investigation after Kong when Kong was
  // fine and a service behind it was not.
  let lastAuth = "no response"
  let lastRealtime = "no response"
  for (let i = 0; i < maxSec; i++) {
    try {
      const [auth, realtime] = await Promise.all([
        fetchWithin(`${base}/auth/v1/health`, 2000),
        fetchWithin(`${base}/realtime/v1/health`, 2000),
      ])
      lastAuth = `HTTP ${auth.status}`
      lastRealtime = `HTTP ${realtime.status}`
      if (auth.ok && realtime.ok) return
    } catch (err) {
      lastAuth = lastRealtime = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(
    `Gateway at ${base} did not become ready within ${maxSec}s ` +
      `(auth/v1/health: ${lastAuth}, realtime/v1/health: ${lastRealtime})`,
  )
}

/** Kong may be up while server → storage is still starting (503 or upstream errors). */
async function waitStorageApiReady(
  kongPort: number,
  serviceRoleKey: string,
  maxSec: number,
): Promise<void> {
  const url = `${loopbackBase(kongPort)}/storage/v1/bucket`
  const headers = { Authorization: `Bearer ${serviceRoleKey}` }
  for (let i = 0; i < maxSec; i++) {
    try {
      const res = await fetchWithin(url, 2000, { headers })
      if (res.ok) return
      const body = await res.text()
      const kongUpstreamDown = body.includes("invalid response was received from the upstream server")
      if (!kongUpstreamDown && res.status !== 503) {
        // Non-transient storage response (e.g. 401), stop waiting.
        return
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.warn(
    `[supatype] Storage API at ${url} did not become ready within ${maxSec}s, bucket provisioning may fail.`,
  )
}

async function provisionDockerStorageBuckets(
  ast: ExtractedSchemaAstV2,
  kongPort: number,
  serviceRoleKey: string,
): Promise<void> {
  await provisionBucketsFromAst(ast, `${loopbackBase(kongPort)}/storage/v1`, serviceRoleKey)
}

let _lastPushedAst: string | null = null
let _lastFailedAst: string | null = null
let _composePushInFlight = false
let _composePushQueued = false

/**
 * Regenerate admin-config + TypeScript types from the AST using the **host** engine.
 * Only schema push/migrate runs in compose (Postgres is not on the host).
 */
async function refreshSchemaArtifacts(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
): Promise<void> {
  const supatypeDir = join(cwd, ".supatype")
  const adminConfigPath = join(supatypeDir, "admin-config.json")

  // Before the engine gate below: these are read straight off the AST, so a push whose engine is
  // unavailable should still leave the server the right maps. The server watches this file, so a
  // hook or validator added to the schema takes effect without restarting the stack.
  //
  // `dev` used to skip both entirely, because only the `direct`/`local` push branch wrote them.
  // Every project running on Compose therefore had a manifest with no `hooks` and no `validators`
  // key, and the server, having nothing to call, ran neither. A hook silently not firing is bad; a
  // validator silently not firing means a write the schema says is checked is accepted with a 201.
  const hooksModule = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  if (hooksModule !== null) console.log(`[supatype] Hook handler types written to ${hooksModule}`)
  if (syncManifestHooks(cwd, ast)) {
    console.log("[supatype] Hook and validator maps written to .supatype/manifest.json")
  }

  try {
    await ensureEngine()
  } catch (err) {
    console.warn(
      `[supatype] Host engine unavailable, admin/types not refreshed: ${(err as Error).message}`,
    )
    return
  }

  const typesPath = config.output?.types
  if (typeof typesPath === "string" && typesPath.trim().length > 0) {
    try {
      const result = await engineRequest<{ code?: string; message?: string }>("/generate", {
        ast,
        lang: "typescript",
      })
      const typesCode = result.code ?? result.message
      if (typeof typesCode === "string" && typesCode.includes("export type")) {
        const marker = typesCode.indexOf("// Generated by supatype-engine")
        const ts = (marker >= 0 ? typesCode.slice(marker) : typesCode).trimStart()
        const hostPath = join(cwd, typesPath)
        mkdirSync(dirname(hostPath), { recursive: true })
        writeFileSync(hostPath, ts)
        console.log(`[supatype] Types written to ${typesPath}`)
      } else {
        console.warn("[supatype] Type generation produced no output.")
      }
    } catch (err) {
      console.warn(`[supatype] Type generation failed: ${(err as Error).message}`)
    }
  }

  try {
    const admin = withAdminRoles(await engineRequest<unknown>("/admin", { ast }), config)
    restoreSystemRelationTargets(admin, ast)
    writeFileSync(adminConfigPath, `${JSON.stringify(admin, null, 2)}\n`)
    console.log("[supatype] Admin config written to .supatype/admin-config.json")
  } catch (err) {
    console.warn(
      `[supatype] Admin config generation failed, Studio may show stale field widgets: ${(err as Error).message}`,
    )
  }
}

async function runComposeSchemaPush(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
): Promise<void> {
  const ast = loadSchemaAst(schemaPath, cwd)
  const astJson = JSON.stringify(ast)

  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const astPath = join(supatypeDir, "schema.ast.json")
  // Always materialise on disk, schema-engine reads via bind mount; skip must not omit the write.
  writeFileSync(astPath, astJson)
  if (astJson === _lastPushedAst && astJson !== _lastFailedAst) return

  if (!existsSync(astPath)) {
    throw new Error(`Failed to write schema AST at ${astPath}`)
  }

  // Admin + types come from the AST only (no DB), refresh before push so Studio stays
  // in sync even when migration fails (e.g. bad engine image, lossy column change).
  await refreshSchemaArtifacts(cwd, config, ast)

  if (hasEngineOverride(config)) {
    console.log("[supatype] Applying schema via local engine (overrides.engine)...")
    await ensureEngine()
    const pgSchema = config.schema?.pg_schema ?? "public"
    const sources = writeSchemaSourcePushArtifacts(cwd)
    try {
      await engineRequest("/push", {
        ast,
        database_url: projectDatabaseUrl(cwd, config),
        schema: pgSchema,
        force: true,
        ...(sources
          ? {
              schema_sources_gz_base64: sources.payload.dataBase64,
              schema_sources_manifest: sources.payload.manifest,
            }
          : {}),
      })
    } catch (err) {
      _lastFailedAst = astJson
      throw err
    }
    _lastPushedAst = astJson
    _lastFailedAst = null
    if (astHasSystemAuthRelation(ast)) {
      grantAuthSchemaAccess(paths, cwd, composeProject)
    }
    console.log("[supatype] Schema applied.")
    return
  }

  console.log("[supatype] Applying schema via compose schema-engine...")
  const sources = writeSchemaSourcePushArtifacts(cwd)
  const runPush = async () => {
    let result = await runComposeEnginePush(paths, cwd, composeProject, config, sources)
    // Windows Docker bind mounts can lag briefly after the host write.
    if (result.status !== 0) {
      await new Promise((r) => setTimeout(r, 250))
      result = await runComposeEnginePush(paths, cwd, composeProject, config, sources)
    }
    return result
  }
  // B: only hold the advisory lock when realtime is already decoding, first-boot
  // push (db only) must not take the lock; that path crashed under lock+DDL in CI.
  const push = composeServiceIsRunning(paths, cwd, composeProject, "realtime")
    ? await withComposeSchemaPushLock(paths, cwd, composeProject, runPush)
    : await runPush()
  if (push.status !== 0) {
    _lastFailedAst = astJson
    const detail = filterComposeNoise(push.output) || push.output
    throw new Error(detail || `Engine schema push failed (exit ${push.status})`)
  }
  _lastPushedAst = astJson
  _lastFailedAst = null

  if (astHasSystemAuthRelation(ast)) {
    grantAuthSchemaAccess(paths, cwd, composeProject)
  }
}

/** Serialize watch-triggered pushes so docker output cannot interleave. */
async function runComposeSchemaPushQueued(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
): Promise<void> {
  if (_composePushInFlight) {
    _composePushQueued = true
    return
  }
  _composePushInFlight = true
  try {
    do {
      _composePushQueued = false
      await runComposeSchemaPush(cwd, config, paths, schemaPath, composeProject)
    } while (_composePushQueued)
  } finally {
    _composePushInFlight = false
  }
}

async function runComposeEnginePush(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  sources?: SchemaSourcePushArtifacts | null,
): Promise<{ status: number; output: string }> {
  const envFile = resolve(cwd, ".env")
  const composeArgs = ["compose", "--progress", "quiet"]
  if (composeProject) composeArgs.push("-p", composeProject)
  composeArgs.push("--project-directory", cwd)
  composeArgs.push("-f", paths.composePath)
  if (existsSync(envFile)) {
    composeArgs.push("--env-file", envFile)
  }
  composeArgs.push(
    "--profile",
    "tools",
    "run",
    "--rm",
    "schema-engine",
    "push",
    "-i",
    "/project/.supatype/schema.ast.json",
    "--database-url",
    projectDatabaseUrl(cwd, config, true),
    "--force",
    "--non-interactive",
  )
  if (sources) {
    composeArgs.push(
      "--schema-sources-gz",
      sources.dockerGzPath,
      "--schema-sources-manifest",
      sources.dockerManifestPath,
    )
  }
  const pushEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROGRESS: "quiet",
  }
  const engineImage = await schemaEngineImageForPush(config)
  if (engineImage) {
    pushEnv.SUPATYPE_ENGINE_IMAGE = engineImage
  }
  const result = spawnSync("docker", composeArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: pushEnv,
  })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  const exitStatus = result.status ?? 1
  const pushResult = parseEnginePushOutput(output)

  if (exitStatus === 0) {
    if (pushResult) {
      console.log(`[supatype] ${formatEnginePushMessage(pushResult)}`)
    } else {
      console.log("[supatype] Schema applied.")
    }
  }

  return { status: exitStatus, output }
}

async function runComposeEngineDiff(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  pgSchema: string,
): Promise<{ status: number; output: string; diff: DiffResult | null }> {
  const envFile = resolve(cwd, ".env")
  const composeArgs = ["compose", "--progress", "quiet"]
  if (composeProject) composeArgs.push("-p", composeProject)
  composeArgs.push("--project-directory", cwd)
  composeArgs.push("-f", paths.composePath)
  if (existsSync(envFile)) {
    composeArgs.push("--env-file", envFile)
  }
  composeArgs.push(
    "--profile",
    "tools",
    "run",
    "--rm",
    "schema-engine",
    "diff",
    "-i",
    "/project/.supatype/schema.ast.json",
    "--database-url",
    projectDatabaseUrl(cwd, config, true),
    "--schema",
    pgSchema,
  )
  const diffEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROGRESS: "quiet",
  }
  const engineImage = await schemaEngineImageForPush(config)
  if (engineImage) {
    diffEnv.SUPATYPE_ENGINE_IMAGE = engineImage
  }
  const result = spawnSync("docker", composeArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: diffEnv,
  })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  const exitStatus = result.status ?? 1
  const diff = parseEngineJsonOutput<DiffResult>(output)

  return { status: exitStatus, output, diff }
}

/**
 * `supatype diff` when `provider: docker`. Uses in-compose schema-engine unless
 * `overrides.engine` is set: then Postgres is published to the host and diff runs
 * through the local engine binary.
 */
export async function diffSchemaDocker(cwd: string, config: SupatypeProjectConfig): Promise<DiffResult> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("diffSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  const pgSchema = config.schema?.pg_schema ?? "public"

  if (hasEngineOverride(config)) {
    const brand = { intro: "Schema diff" }
    await ensureDockerDbPublishedForHostEngine(cwd, config, brand)
    const schemaPath = schemaPathFromProject(config, cwd)
    const ast = loadSchemaAst(schemaPath, cwd)
    await ensureEngine()
    return engineRequest<DiffResult>("/diff", {
      ast,
      database_url: projectDatabaseUrl(cwd, config),
      schema: pgSchema,
    })
  }

  const kongPort = await resolveKongPort(cwd, project)
  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, devJwtSecret(cwd))
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, devJwtSecret(cwd))
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, undefined)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
  const diffBrand = { intro: "Schema diff" }

  await startComposeDatabase(config, paths, cwd, project, diffBrand)

  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = loadSchemaAst(schemaPath, cwd)

  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const astPath = join(supatypeDir, "schema.ast.json")
  writeFileSync(astPath, JSON.stringify(ast))

  let result = await runComposeEngineDiff(paths, cwd, project, config, pgSchema)
  // Windows Docker bind mounts can lag briefly after the host write.
  if (result.status !== 0) {
    await new Promise((r) => setTimeout(r, 250))
    result = await runComposeEngineDiff(paths, cwd, project, config, pgSchema)
  }
  if (result.status !== 0) {
    const detail = filterComposeNoise(result.output) || result.output
    throw new Error(detail || `Engine schema diff failed (exit ${result.status})`)
  }
  if (!result.diff) {
    throw new Error("Engine diff returned no result")
  }
  return result.diff
}

/**
 * `supatype push` when `provider: docker`. Uses in-compose schema-engine unless
 * `overrides.engine` is set: then Postgres is published to the host and push runs
 * through the local engine binary (AST v2, contributor builds).
 */
export async function pushSchemaDocker(cwd: string, config: SupatypeProjectConfig): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("pushSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd, project)
  // No dev db port for an external database: `ensureDevDbPort` allocates a host port for the `db`
  // container *and persists a matching DATABASE_URL*, which overwrote the operator's own URL, the
  // one the whole stack and every CLI command reads.
  const devDbPort =
    hasEngineOverride(config) && !usesExternalDatabase(config)
      ? await resolveDevDbPort(cwd)
      : undefined

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, devJwtSecret(cwd))
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, devJwtSecret(cwd))
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
  const pushBrand = { intro: "Push schema" }

  console.log(`[supatype] provider docker, applying schema via compose (project ${project})...`)
  await startComposeDatabase(config, paths, cwd, project, pushBrand)

  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = loadSchemaAst(schemaPath, cwd)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project)

  const upGateway = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project, {
    quiet: true,
    brand: pushBrand,
  })
  if (upGateway !== 0) {
    exitComposeFailed(upGateway, "Could not start the Compose gateway stack.", pushBrand)
  }
  await waitKongReady(kongPort, 120)
  await waitStorageApiReady(kongPort, serviceRoleKey, 90)
  await provisionDockerStorageBuckets(ast, kongPort, serviceRoleKey)

  await ensureFirstAdminUserForProject(cwd, config, {
    compose: { project, composePath: paths.composePath },
  })

  console.log("[supatype] Schema pushed.")
}

export async function runDevCompose(cwd: string, config: SupatypeProjectConfig, opts: DevComposeOptions): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("runDevCompose requires provider: docker")
  }

  // Per-project compose name + port isolate this project from any other Supatype
  // stack on the machine (own containers, volumes, network, and gateway port).
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd, project)
  // No dev db port for an external database: `ensureDevDbPort` allocates a host port for the `db`
  // container *and persists a matching DATABASE_URL*, which overwrote the operator's own URL, the
  // one the whole stack and every CLI command reads.
  const devDbPort =
    hasEngineOverride(config) && !usesExternalDatabase(config)
      ? await resolveDevDbPort(cwd)
      : undefined

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, devJwtSecret(cwd))
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, devJwtSecret(cwd))

  const devBrand = { intro: "Local development" }
  const localServerImage = await ensureLocalServerDockerImage(cwd, config, devBrand)

  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  console.log(`[supatype] provider docker, starting self-host Compose stack (project ${project}, gateway :${kongPort})...`)
  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
  if (ensureDevApiConfig(cwd)) {
    console.log("[supatype] API config written to .supatype/api-config.json")
  }

  type StudioProc = Awaited<ReturnType<typeof startStudioViteDevServer>>
  type AppProc = ReturnType<typeof startProxyDevApp>
  const shutdownState: {
    studioProc: StudioProc
    appProc: AppProc
    schemaWatcher: import("node:fs").FSWatcher | null
    debounceTimer: ReturnType<typeof setTimeout> | null
  } = {
    studioProc: null,
    appProc: null,
    schemaWatcher: null,
    debounceTimer: null,
  }

  registerDevShutdown(async () => {
    shutdownState.schemaWatcher?.close()
    shutdownState.schemaWatcher = null
    if (shutdownState.debounceTimer) {
      clearTimeout(shutdownState.debounceTimer)
      shutdownState.debounceTimer = null
    }
    console.log("[supatype] Shutting down compose...")
    await shutdownState.studioProc?.stop()
    await shutdownState.appProc?.stop()
    const downStatus = runDockerCompose(paths.composePath, ["down"], cwd, project, { quiet: true })
    if (downStatus === 0) {
      console.log("[supatype] Compose stack stopped.")
    } else {
      console.warn(`[supatype] Compose down exited with status ${downStatus}.`)
    }
  }, {
    cwd,
    compose: { cwd, composePath: paths.composePath, composeProject: project },
  })

  await recoverStaleDevSession(cwd)
  await handleComposeProjectRename(cwd, config.project.name, paths)

  if (!usesExternalDatabase(config)) {
    console.log("[supatype] Bringing up Postgres (compose db)...")
  }
  await startComposeDatabase(config, paths, cwd, project, devBrand, 180_000, endDevSession)
  // Settle before DDL: pg_isready can pass slightly before the instance is stable.
  await new Promise((r) => setTimeout(r, 3000))

  if (!usesExternalDatabase(config)) {
    reconcileAuthenticatorPassword(paths, cwd, project)
  }

  // A: apply schema before realtime (and the rest of the stack) starts decoding WAL.
  const schemaPath = schemaPathFromProject(config, cwd)
  {
    const maxAttempts = 3
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runComposeSchemaPush(cwd, config, paths, schemaPath, project)
        lastErr = undefined
        break
      } catch (e: unknown) {
        lastErr = e
        console.error(
          `[supatype] Initial schema push failed (attempt ${attempt}/${maxAttempts}):`,
          (e as Error).message,
        )
        dumpComposeDbLogs(paths, cwd, project, `schema push attempt ${attempt}/${maxAttempts}`)
        if (attempt < maxAttempts) {
          // Only for a database Supatype created. Tearing down an external one is not ours to do,
          // and `down -v` would destroy the stack's other volumes for a failure that was never
          // about Postgres.
          if (!usesExternalDatabase(config)) {
            console.log("[supatype] Resetting Postgres after failed schema push...")
            runDockerCompose(paths.composePath, ["down", "-v"], cwd, project, {
              quiet: true,
              brand: devBrand,
            })
            await startComposeDatabase(config, paths, cwd, project, devBrand)
          }
          await new Promise((r) => setTimeout(r, 3000 * attempt))
        }
      }
    }
    if (lastErr) {
      dumpComposeDbLogs(paths, cwd, project, "initial schema push exhausted")
      endDevSession()
      throw new Error(
        `Initial schema push failed after ${maxAttempts} attempts: ${(lastErr as Error).message}`,
      )
    }
  }

  console.log("[supatype] Bringing up Docker Compose services...")
  const upStatus = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project, {
    quiet: true,
    brand: devBrand,
  })
  if (upStatus !== 0) {
    endDevSession()
    exitComposeFailed(upStatus, "Could not start the local Compose stack.", devBrand)
  }

  if (localServerImage !== undefined) {
    console.log("[supatype] Recreating server with local image...")
    const recreateStatus = runDockerCompose(
      paths.composePath,
      ["up", "-d", "--force-recreate", "--no-deps", "server"],
      cwd,
      project,
      { quiet: true, brand: devBrand },
    )
    if (recreateStatus !== 0) {
      endDevSession()
      exitComposeFailed(recreateStatus, "Could not recreate the server container with the local image.", devBrand)
    }
  }

  const pinnedRealtimeImage = readEnvValue(cwd, "SUPATYPE_REALTIME_IMAGE", "").trim()
  if (pinnedRealtimeImage !== "") {
    console.log("[supatype] Recreating realtime with pinned image...")
    const rtStatus = runDockerCompose(
      paths.composePath,
      ["up", "-d", "--force-recreate", "--no-deps", "realtime"],
      cwd,
      project,
      { quiet: true, brand: devBrand },
    )
    if (rtStatus !== 0) {
      endDevSession()
      exitComposeFailed(rtStatus, "Could not recreate the realtime container.", devBrand)
    }
  }

  console.log("[supatype] Waiting for API gateway...")
  await waitKongReady(kongPort, 120)
  console.log("[supatype] Waiting for storage API...")
  await waitStorageApiReady(kongPort, serviceRoleKey, 90)

  await ensureFirstAdminUserForProject(cwd, config, {
    compose: { project, composePath: paths.composePath },
  })

  writeLocalEnvironment(cwd, {
    target: "local",
    apiUrl: `http://localhost:${kongPort}`,
    databaseUrl: projectDatabaseUrl(cwd, config, !hasEngineOverride(config)),
    projectRef: config.project.name,
    kongPort,
    provider: "docker",
  })

  writeDevSessionLock(cwd, {
    composeProject: project,
    projectRef: config.project.name,
    composePath: paths.composePath,
    kongPort,
    startedAt: new Date().toISOString(),
  })

  const ast = loadSchemaAst(schemaPath, cwd)
  await provisionDockerStorageBuckets(ast, kongPort, serviceRoleKey)

  const pidDir = join(homedir(), ".supatype", "projects", config.project.name, "pid")
  mkdirSync(pidDir, { recursive: true })

  startDevSession()

  let studioProc: StudioProc = null
  const studioOverride = config.overrides?.studio
  if (studioOverride) {
    studioProc = startStudioViteDevServer({
      cwd,
      studioOverride,
      pidDir,
      serviceRoleKey,
      proxyTarget: `http://localhost:${kongPort}`,
      viteSupatypeUrl: `http://localhost:${STUDIO_DEV_PORT}`,
      basePath: "/studio/",
    })
    studioProc?.start()
    shutdownState.studioProc = studioProc
    if (studioProc) {
      console.log(
        `[supatype] Studio (overrides.studio): live reload proxied at http://localhost:${kongPort}/studio/`,
      )
    }
  }

  const links = [
    { label: "API", url: `http://localhost:${kongPort}` },
    { label: "REST", url: `http://localhost:${kongPort}/rest/v1/` },
    { label: "Auth", url: `http://localhost:${kongPort}/auth/v1/` },
    { label: "Storage", url: `http://localhost:${kongPort}/storage/v1/` },
    { label: "Realtime", url: `ws://localhost:${kongPort}/realtime/v1/` },
  ]
  if (resolveProxyDevScript(config) !== null) {
    links.push({ label: "App", url: `http://localhost:${kongPort}/` })
  }
  links.push({ label: "Studio", url: `http://localhost:${kongPort}/studio/` })

  const hints: string[] = []
  if (existsSync(join(cwd, "seed.ts"))) {
    hints.push("Demo data: pnpm seed")
  }

  publishDevReady({
    title: `Services running (Docker · ${project})`,
    links,
    anonKey,
    serviceRoleKey,
    ...(hints.length > 0 ? { hints } : {}),
  })

  const appProc = startProxyDevApp(cwd, config, pidDir)
  shutdownState.appProc = appProc

  if (opts.watch) {
    const schemaDir = join(projectRootFromConfig(config, cwd), config.schema?.path ?? "schema/index.ts", "..")
    console.log(`[supatype] Watching ${schemaDir} for changes...`)
    const { watch } = await import("node:fs")
    shutdownState.schemaWatcher = watch(schemaDir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith(".ts")) return
      if (shutdownState.debounceTimer) clearTimeout(shutdownState.debounceTimer)
      shutdownState.debounceTimer = setTimeout(() => {
        shutdownState.debounceTimer = null
        console.log(`\n[supatype] Change detected in ${filename}, pushing schema...`)
        runComposeSchemaPushQueued(cwd, config, paths, schemaPath, project)
          .then(async () => {
            const updatedAst = loadSchemaAst(schemaPath, cwd)
            await provisionDockerStorageBuckets(updatedAst, kongPort, serviceRoleKey)
          })
          .catch((e: unknown) =>
            console.error("[supatype] Schema push failed:", (e as Error).message),
          )
      }, 300)
    })
  }

  await new Promise<never>(() => undefined)
}

function astHasSystemAuthRelation(ast: unknown): boolean {
  const obj = ast as { models?: Array<{ fields?: Record<string, { kind?: string; target?: string }> }> }
  if (!obj?.models) return false
  for (const model of obj.models) {
    if (!model.fields) continue
    for (const field of Object.values(model.fields)) {
      if (field.kind === "relation" && field.target === "supatype:user") return true
    }
  }
  return false
}

/**
 * Set `authenticator`'s password to the one `.env` holds, every time the stack starts.
 *
 * The Postgres image passwords that role from `AUTHENTICATOR_PASSWORD` in its init scripts, which
 * run once, on an empty data directory. So the value the role actually has is whatever `.env` said
 * the day the volume was created, and `.env` can move afterwards. When the two diverge PostgREST
 * cannot log in, exits, and every REST request answers 502 with the real reason visible only in a
 * container log the developer has no reason to read.
 *
 * Reconciling here makes `.env` the answer to what the password is, rather than the volume's
 * birthday. It is idempotent, and it runs before the schema push so the API is already reachable by
 * the time the stack reports ready.
 */
function reconcileAuthenticatorPassword(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): void {
  const composeDir = dirname(paths.composePath)
  const owner = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const database = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  const result = spawnSync(
    "docker",
    [
      "compose", "-p", composeProject, "-f", paths.composePath,
      "exec", "-T",
      "-e", `PGPASSWORD=${devPostgresPassword(cwd)}`,
      "-e", `SUPATYPE_AUTHENTICATOR_PASSWORD=${devAuthenticatorPassword(cwd)}`,
      "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", owner, "-d", database,
    ],
    {
      cwd: composeDir,
      encoding: "utf8",
      timeout: 10_000,
      // `\getenv` reads the value from the container's environment, so the password is never a
      // `docker exec` argument, which any process listing on the machine would show.
      input: [
        "\\getenv pw SUPATYPE_AUTHENTICATOR_PASSWORD",
        "ALTER ROLE authenticator WITH LOGIN PASSWORD :'pw';",
        "",
      ].join("\n"),
    },
  )
  if (result.status !== 0) {
    console.warn(
      "[supatype] Could not set the authenticator password; the REST API may answer 502.",
    )
  }
}

function grantAuthSchemaAccess(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): void {
  const composeDir = dirname(paths.composePath)
  const baseArgs = [
    "compose", "-p", composeProject,
    "-f", paths.composePath,
  ]
  const sql = "GRANT USAGE ON SCHEMA auth TO service_role; GRANT SELECT ON auth.users TO service_role;"
  const result = spawnSync(
    "docker",
    [...baseArgs, "exec", "-T", "-e", "PGPASSWORD=postgres", "db",
     "psql", "-U", "supatype_admin", "-d", "supatype", "-c", sql],
    { cwd: composeDir, encoding: "utf8", timeout: 10_000 },
  )
  if (result.status !== 0) {
    console.warn("[supatype] Could not grant service_role access to auth.users, Studio relation preview may fail.")
  }
}
