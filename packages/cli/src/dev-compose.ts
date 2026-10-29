/**
 * `supatype dev` when `provider: docker`, full self-host Compose stack (Kong gateway).
 */

import { projectOutputPaths, writeAstDerivedOutputs, writeSeedBuilder } from "./type-generation.js"
import { errorMessage } from "./error-message.js"
import { withPublishing } from "./model-versioning.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { startProxyDevApp, resolveProxyDevScript } from "./app/proxy-dev-app.js"
import { loadSchemaAst, projectNameInFile } from "./config.js"
import { withComposeSchemaPushLock } from "./schema-push-lock.js"
import { recordDatabaseTier, sameApiSurface } from "./recorded-field-masking-tier.js"
import {
  connectionString,
  pgSchema,
  projectRootFromConfig,
  resolveRuntimeProvider,
  hooksPathFromProject,
  schemaPathFromProject,
  selfHostTlsEnabled,
  usesExternalDatabase,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { syncManifestHooks, writeHooksModule } from "./model-hooks.js"
import { rowCacheChangeNote, syncRowCacheEnv } from "./model-cache.js"
import { anonKeyEnvUpdates } from "./commands/keys.js"
import { devApiKeys } from "./dev-api-keys.js"
import { warnUrlUnsafeComposePasswords } from "./url-safe-passwords.js"
import { astRelatesToAuthUsers } from "./byo-preflight.js"
import { ensureDevDbPort, ensureKongPort } from "./dev-ports.js"
import { applyForThisRun, splitShellPortUpdates } from "./shell-ports.js"
import { handleComposeProjectRename } from "./compose-rename.js"
import { devSessionLockFor, recoverStaleDevSession, writeDevSessionLock } from "./dev-session-lock.js"
import { endDevSession, startDevSession } from "./dev-session.js"
import { ensureDevApiConfig } from "./ensure-dev-api-config.js"
import { cacheSeedingNotes } from "./api-config-cache.js"
import { refreshFunctionsContext } from "./functions-context-refresh.js"
import { restartComposeFunctionsWorker, watchFunctionSources } from "./dev-functions-watch.js"
import { watchDevSchema } from "./dev-schema-watch.js"
import { databaseUrlSyncMessage, syncDatabaseUrlPort } from "./db-port.js"
import { degraded } from "./strict.js"
import { DEV_DESTRUCTIVE_POLICY, consentDepsFromDiff, pushConsentingToDestructive } from "./destructive-consent.js"
import { auditFlags, auditWhenSupported } from "./push-audit.js"
import { consentRefusal, reportDevPushFailure } from "./push-refusal.js"
import {
  COMPOSE_PINNED_IMAGE_ENV_KEYS,
  composeDockerImageEnv,
  composeProjectName,
  exitComposeFailed,
  publishesDbToHost,
  runDockerCompose,
  schemaEngineImageForPush,
  writeSelfHostCompose,
  composeFieldMaskingTier,
  selfHostComposePaths,
  type SelfHostComposePaths,
} from "./self-host-compose.js"
import { composeServiceIsRunning } from "./compose-kong.js"
import type { DockerBrandOptions } from "./docker-runtime.js"
import { hasEngineOverride } from "./binary-cache.js"
import { STUDIO_DEV_PORT, startStudioViteDevServer } from "./studio-dev-server.js"
import {
  ensureLocalServerDockerImage,
  usesLocalServerImage,
  LOCAL_SERVER_DOCKER_IMAGE,
} from "./compose-local-server-image.js"
import { ensureEngine, enginePush, engineRequest, type AdoptOutcome, type ComposeEngine, type DiffResult } from "./engine-client.js"
import {
  isAdoptOutcome,
  isAnyAnswer,
  isDiffResult,
  isEnginePushResult,
  isGenerateAnswer,
  isObjectAnswer,
} from "./engine-answers.js"
import { writeSchemaSourcePushArtifacts, type SchemaSourcePushArtifacts } from "./schema-sources.js"
import { readEnvValue, upsertEnvFile } from "./env-file.js"
import { warnProjectAuthProviderSecrets } from "./auth-providers.js"
import {
  devDatabaseIdentity,
  devDatabaseUrl,
  seedMissingDatabaseIdentity,
  seedMissingLocalSecrets,
} from "./local-secrets.js"
import { writeLocalEnvironment } from "./link.js"
import { registerDevShutdown, waitForDevShutdown } from "./dev-shutdown.js"
import {
  filterComposeNoise,
  parseEngineJsonOutput,
  parseEnginePushOutput,
  reportAppliedPush,
} from "./engine-push-output.js"
import { withAdminRoles } from "./studio-admin-roles.js"
import { restoreSystemRelationTargets } from "./restore-system-relation-targets.js"
import { provisionBucketsFromAst } from "./storage-provision.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"
import { ensureFirstAdminUserForProject } from "./commands/admin.js"
import { demoDataHint, publishDevReady } from "./dev-ready-panel.js"
import { pushInitialSchema, settleInitialPush, type InitialPushOutcome, type InitialPushSteps } from "./dev-initial-push.js"
import { offerAdoption, targetAdoptionSteps, type AdoptionSteps } from "./adopt-walkthrough.js"
import { resetDevDatabase } from "./dev-db-reset.js"
import {
  adoptKeysNeed,
  assertSupported,
  engineCapabilities,
  identityColumnsNeed,
  OVERWRITE_DRIFT_NEED,
  probeCapabilities,
  type Capabilities,
  type FeatureNeed,
} from "./engine-ownership-gate.js"
import { devPushConsentingToDrift } from "./drift-consent.js"
import { capabilitiesCache, rememberCapabilitiesSync, type CapabilitiesCache } from "@supatype/shared"
import { waitForDatabaseAfterUp } from "./dev-db-ready.js"
import {
  DERIVED_DSN_SOURCE,
  hostComposeDbUrl,
  requireRunningStack,
  resolveHostDatabaseUrl,
  stackHostDbUrl,
} from "./host-database.js"
import { studioUrlAt } from "./local-stack.js"
import {
  grantAuthSchemaAccess,
  privatizeTableDefaults,
  reconcileAuthenticatorPassword,
  reconcileSqlEditorPassword,
} from "./compose-db-roles.js"
import { spawnComposeEngine } from "./compose-engine-run.js"
import { waitForRestReady } from "./rest-ready.js"
import { claimDevRenderMode, composeRenderMode, composeRenderOptions, type ComposeRenderMode } from "./compose-render-mode.js"
import { devMailerAutoconfirmUpdate, MAILER_AUTOCONFIRM_ENV } from "./mailer-autoconfirm.js"
import { mailerProviderEnv } from "./mailer-env.js"

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
  /** Remove the Postgres data volume before starting, after confirmation. Never implied. */
  resetDb: boolean
  /** The reset was already confirmed on the command line, so do not prompt for it. */
  yes: boolean
  /** `--overwrite-drift`: every push of the session puts back access changed outside Supatype. */
  overwriteDrift?: boolean
}

/** In-compose Postgres URL (SCRAM; not published to the host). */
export function composeDbUrl(cwd: string): string {
  return devDatabaseUrl(cwd, "db:5432")
}

/**
 * The database URL to hand a tool, from wherever it happens to run.
 *
 * The compose helpers below describe the `db` *container*, on the host at the port the stack's
 * layout publishes (`stackHostDbUrl`), or in-network at `db:5432`. Neither exists for a project
 * pointed at an external database, and passing one produced "pool timed out while waiting for an
 * open connection", a message with nothing in it about the URL being wrong.
 */
function projectDatabaseUrl(cwd: string, config: SupatypeProjectConfig, inNetwork = false): string {
  if (usesExternalDatabase(config)) return connectionString(config)
  return inNetwork ? composeDbUrl(cwd) : stackHostDbUrl(cwd, config.project.name)
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
  if (!publishesDbToHost(config)) {
    throw new Error(
      "This project uses an external database, so there is no Docker Postgres to publish. " +
        "Point DATABASE_URL at it, or pass --connection.",
    )
  }

  const project = composeProjectName(config.project.name)
  // A standalone stack already publishes its database (SUPATYPE_DB_PORT), and its .env is the
  // operator's: only a dev stack gets the dev port and the dev values (SH1). With no stack running
  // the URL the engine is handed cannot be derived, so refuse before starting anything (M1b).
  const mode = requireRunningStack(cwd, config.project.name)
  if (mode === "dev") await prepareDevComposeEnv(cwd, config, project, await resolveKongPort(cwd, project))

  const paths = writeSelfHostCompose(cwd, config, { devLocal: mode === "dev" })
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
  // The URL comes from the one resolver every host-side command uses. It is resolved first so a
  // derived URL with no stack running refuses before anything starts (M1b), and a DATABASE_URL
  // someone set is used without one. Then, when it is this project's local docker Postgres, the
  // database is published so the URL reaches something.
  const resolved = resolveHostDatabaseUrl(cwd, config, { connection: explicit, allowDerived: true })
  if (resolved.source === DERIVED_DSN_SOURCE && usesLocalDockerEngineDb(config, explicit)) {
    await ensureDockerDbPublishedForHostEngine(cwd, config)
  }
  return resolved.dsn
}

/**
 * The project's own engine image in its compose stack, for a docker project with no
 * `overrides.engine` and no `connection` of its own; otherwise undefined, and the host binary runs.
 *
 * The image push uses ({@link schemaEngineImageForPush}), reaching the database as push does. Doctor,
 * adopt, type generation and the admin config ran the host binary instead, the pin or whatever was
 * cached, so `adopt --key` was refused by an engine that did not know the flag (A5-N2) and dev's
 * types failed on a feature the compose push had just applied (A5-N3).
 */
export async function projectComposeEngine(
  cwd: string,
  config: SupatypeProjectConfig,
): Promise<ComposeEngine | undefined> {
  if (resolveRuntimeProvider(config) !== "docker" || hasEngineOverride(config)) return undefined
  if (config.connection?.trim()) return undefined
  const paths = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
  const project = composeProjectName(config.project.name)
  const engineImage = await schemaEngineImageForPush(config, cwd)
  return {
    target: { cwd, project, composePath: paths.composePath, engineImage },
    databaseUrl: projectDatabaseUrl(cwd, config, true),
    capabilities: () => dockerEngineCapabilities(cwd, config),
  }
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
 *
 * Warns rather than refuses about a URL-unsafe password. dev has refused before it gets here, and
 * push and diff are not stopped over a database that starts either way: the warning names the
 * cause before any connection failure it leads to.
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
  warnUrlUnsafeComposePasswords(cwd, config)

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
    ...seedMissingLocalSecrets(cwd, config),
    // Project configuration, seeded not overwritten, see seedMissingDatabaseIdentity.
    ...seedMissingDatabaseIdentity(cwd, config),
    // Shared with `supatype keys --write`, so a front end's prefix cannot be written by one and
    // forgotten by the other. See `anonKeyEnvUpdates`.
    //
    // This list used to live here as well, and the two had already drifted: `dev` wrote
    // PUBLIC_ and EXPO_PUBLIC_ URLs and no VITE_SUPATYPE_URL, so a Vite app whose `.env` had only
    // ever been touched by `supatype dev` built against an empty string.
    ...anonKeyEnvUpdates(anonKey, serviceRoleKey, apiUrl),
    SUPATYPE_KONG_PORT: String(kongPort),
    API_EXTERNAL_URL: apiUrl,
    SITE_URL: apiUrl,
    // From auth.email.enableConfirmations, unless the developer set their own in .env.
    ...devMailerAutoconfirmUpdate(cwd, config),
    // email.provider and its settings, which the compose file passes to the server. The compose
    // path used to carry none of them, so a project that asked for smtp, Resend or SES got the auth
    // service's noop client and no message at all.
    ...mailerProviderEnv(config.email),
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
    updates.DATABASE_URL = hostComposeDbUrl(cwd, devDbPort)
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
  // The server refuses to start when *any* retired name is in scope, and it reads the project's
  // config files into its environment before checking, so a `.env` this CLI wrote under the old
  // spelling is fatal to a stack that has otherwise been upgraded. Only the key this file used to
  // write is removed: an operator's own GOTRUE_ variable is theirs, and the server's error names it
  // and its replacement precisely enough to fix by hand.
  const retiredKeys = ["GOTRUE_MAILER_AUTOCONFIRM"]
  // A port the shell gave for this run is the run's, not the project's (DR9).
  const { persist, runOnly } = splitShellPortUpdates(updates)
  applyForThisRun(runOnly)
  upsertEnvFile(cwd, persist, {
    removeManaged: removeImageKeys,
    managed: [...managedImageKeys, MAILER_AUTOCONFIRM_ENV],
    // A local image left in `.env` after the project stopped asking for one would keep pointing
    // compose at a stale build, and it carries no marker for `removeManaged` to act on.
    remove: [
      ...retiredKeys,
      ...(!wantsLocalServer && !("SUPATYPE_SERVER_IMAGE" in imagePins)
        ? ["SUPATYPE_SERVER_IMAGE"]
        : []),
    ],
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

/**
 * The dev `.env` a push to a dev stack keeps current: the dev database port and the dev values.
 * Only for a dev stack: on a standalone one these are the operator's, and a push that wrote
 * `SITE_URL`, `SUPATYPE_MAILER_AUTOCONFIRM=true` and a dev `DATABASE_URL` over them broke the
 * deployment's links and turned email confirmation off (SH1).
 */
async function prepareDevComposeEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  project: string,
  kongPort: number,
): Promise<void> {
  // No dev db port for an external database: `ensureDevDbPort` allocates a host port for the `db`
  // container *and persists a matching DATABASE_URL*, which overwrote the operator's own URL, the
  // one the whole stack and every CLI command reads.
  // Whatever compose publishes, `DATABASE_URL` has to point at. Gating this on
  // `overrides.engine` while the compose file published unconditionally is what left a project
  // with a database on 54329 and a URL still saying 5432.
  const devDbPort = publishesDbToHost(config) ? await ensureDevDbPort(cwd, { composeProject: project }) : undefined
  const { anonKey, serviceRoleKey } = devApiKeys(cwd)
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)
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
      // Over TCP, deliberately, not the Unix socket.
      //
      // On a first run the Postgres entrypoint starts a temporary server with `listen_addresses=''`
      // to run the init scripts, then shuts it down and starts the real one. That temporary server
      // answers on the socket, so a socket `pg_isready` reports ready during init and the very next
      // thing to connect meets "the database system is shutting down". It is why the initial push
      // failed three times in a row on a clean machine while a warm one was fine.
      //
      // TCP is the distinction the entrypoint itself draws: the init server does not listen on it.
      [
        ...baseArgs, "exec", "-T", "db",
        "pg_isready", "-h", "127.0.0.1", "-U", devDatabaseIdentity(cwd).user,
      ],
      { cwd: composeDir, encoding: "utf8" },
    )
    if (ready.status === 0) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("Compose db service did not become healthy in time")
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

/**
 * Print what the stack is doing when the gateway never comes up.
 *
 * A 503 through the gateway means Kong is running and something behind it is
 * not, and until now the only thing said was that the gateway was not ready.
 * That sends people to look at Kong, which is almost never the problem, and in
 * CI the containers are gone by the time anything else can inspect them.
 */
function reportUnhealthyStack(composePath: string, cwd: string, project: string): void {
  const capture = (args: string[]): string => {
    const result = spawnSync("docker", ["compose", "-p", project, "--project-directory", cwd, "-f", composePath, ...args], {
      encoding: "utf8",
      cwd,
    })
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  }

  console.error("")
  console.error("[supatype] The gateway is up but a service behind it is not. Container state:")
  const state = capture(["ps", "-a"])
  console.error(state === "" ? "  (no containers)" : state)

  // The two the gateway health check depends on, and db because both need it.
  for (const service of ["server", "realtime", "db"]) {
    const logs = capture(["logs", "--no-color", "--tail", "40", service])
    if (logs === "") continue
    console.error("")
    console.error(`[supatype] last 40 lines from ${service}:`)
    console.error(logs)
  }
  console.error("")
}

async function waitKongReady(
  kongPort: number,
  maxSec: number,
  stack?: { composePath: string; cwd: string; project: string },
): Promise<void> {
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
      lastAuth = lastRealtime = errorMessage(err)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (stack !== undefined) {
    reportUnhealthyStack(stack.composePath, stack.cwd, stack.project)
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
/** The schema the last push read, whether it applied, was refused or failed. */
let _lastReadAst: string | null = null
let _composePushInFlight = false
let _composePushQueued = false

/**
 * Regenerate everything derived from the schema once a push has applied it: the AST-derived files,
 * then the types and admin config from the engine. Never called for a push that was refused or
 * failed. A docker project with no `overrides.engine` uses its own engine image, the one that
 * pushed (A5-N3); otherwise the host binary, falling back to the image when the binary cannot be
 * fetched.
 */
async function refreshSchemaArtifacts(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
): Promise<void> {
  writeAstDerivedArtifacts(cwd, config, ast)
  const adminConfigPath = join(cwd, ".supatype", "admin-config.json")
  let engine: ComposeEngine | undefined
  try {
    engine = await projectComposeEngine(cwd, config)
  } catch (err) {
    degraded("The project's engine image could not be resolved, admin config and types not refreshed", errorMessage(err))
    return
  }
  if (engine === undefined && !(await hostEngineOrComposeFallback(cwd, config, ast, adminConfigPath))) return
  await writeEngineArtifacts(cwd, config, ast, adminConfigPath, engine)
}

/** The files read straight off the applied AST, written whatever happens with the generator afterwards. */
function writeAstDerivedArtifacts(cwd: string, config: SupatypeProjectConfig, ast: unknown): void {
  // Before the generator: these are read straight off the AST, so an applied push whose engine
  // cannot generate still leaves the server the right maps. The server watches this file, so a
  // hook or validator added to the schema takes effect without restarting the stack.
  //
  // `dev` used to skip both entirely, because only the `direct`/`local` push branch wrote them.
  // Every project running on Compose therefore had a manifest with no `hooks` and no `validators`
  // key, and the server, having nothing to call, ran neither. A hook silently not firing is bad; a
  // validator silently not firing means a write the schema says is checked is accepted with a 201.
  const hooksModule = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  if (hooksModule !== null) console.log(`[supatype] Hook handler types written to ${hooksModule}`)
  // And the context module, on the same terms. `init` and `functions new` wrote it and nothing
  // else did, so a project that already had functions when the two-argument contract landed never
  // received one: its handlers had no `FunctionContext` to import.
  if (refreshFunctionsContext(cwd, config)) {
    console.log("[supatype] Function context type written to functions/_shared/context.ts")
  }
  if (syncManifestHooks(cwd, ast)) {
    console.log("[supatype] Hook and validator maps written to .supatype/manifest.json")
  }
  // Written before the stack comes up, so a first run with a row cache declared starts with it on
  // rather than needing a second `supatype dev`.
  const rowCache = syncRowCacheEnv(cwd, ast)
  if (rowCache !== null) {
    console.log(`[supatype] ${rowCacheChangeNote(rowCache)}`)
  }

  syncDatabaseUrlToStack(cwd, config)

  // The declaration is a ceiling and the allowlist is what is actually on, and only `push` ever
  // seeded the allowlist. So a stack brought up with `supatype dev` alone had every model's
  // `cache` block declared and nothing switched on: `.cache({ server: true })` answered BYPASS,
  // and the only way to find out why was to open Studio and tick a box the schema had already
  // justified.
  for (const note of cacheSeedingNotes(cwd, ast)) console.log(`[supatype] ${note}`)
}

/**
 * Point `DATABASE_URL` at the port the stack being worked on publishes Postgres on.
 *
 * The port variable moves what compose binds; DATABASE_URL is what seeds and psql use. Nothing
 * reconciled them, so a project moved off 5432 to avoid a clash came up perfectly and then failed
 * on `npm run seed` with ECONNREFUSED against a port nothing was listening on. The layout is the
 * stack's own (dev while a dev session holds it, otherwise self-host), so a self-host push in a
 * project that once ran dev keeps the self-host port, and the message names the variable it read.
 */
function syncDatabaseUrlToStack(cwd: string, config: SupatypeProjectConfig): void {
  const dbPort = syncDatabaseUrlPort(cwd, composeRenderMode(cwd, config.project.name) === "dev")
  if (dbPort === null) return
  console.log(`[supatype] ${databaseUrlSyncMessage(dbPort)}`)
}

/**
 * True when the host engine binary is ready. When it is not, the in-compose engine writes the
 * admin config and types instead and this answers false, having said which happened.
 */
async function hostEngineOrComposeFallback(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
  adminConfigPath: string,
): Promise<boolean> {
  try {
    await ensureEngine()
    return true
  } catch (err) {
    // A project that named its engine gets that engine or an error, never a stand-in.
    if (hasEngineOverride(config)) {
      degraded("overrides.engine could not be used, admin config and types not refreshed", errorMessage(err))
      return false
    }
    // The host engine is a CDN download and this machine could not complete it. The schema is
    // already applied, so fall back to the engine in compose rather than giving up: without
    // admin-config.json Studio reports "No schema has been pushed yet" on a stack whose schema is
    // entirely live, which reads as a failed push rather than a missing binary.
    const paths = selfHostComposePaths(cwd)
    const composeProject = composeProjectName(config.project.name)
    const wrote = await generateViaComposeEngine(paths, cwd, composeProject, config, ast, adminConfigPath)
      .catch(() => false)
    // Reported through `degraded` rather than warned, so a run that takes this path says so where
    // CI looks, rather than in a line that scrolls past.
    const message = errorMessage(err)
    if (wrote) {
      degraded("Host engine unavailable, used the in-compose engine instead", message)
    } else {
      degraded(
        "Host engine unavailable, admin config and types not refreshed",
        `${message}\n[supatype] Studio will report no schema until this succeeds, even though the ` +
          "schema is applied. Retry with the stack up, or run `supatype push`.",
      )
    }
    return false
  }
}

/** The types, the AST outputs and the admin config, from `engine` (the host binary when undefined). */
async function writeEngineArtifacts(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
  adminConfigPath: string,
  engine: ComposeEngine | undefined,
): Promise<void> {
  // At the default paths when `output` is not set, which is every project `init` made before it
  // wrote one: gated on `output.types`, a renamed field left the typed client on the old name.
  const { typesPath } = projectOutputPaths(config.output)
  try {
    const result = await engineRequest("/generate", { ast, lang: "typescript" }, isGenerateAnswer, engine)
    if (writeEngineTypes(cwd, typesPath, result.code ?? result.message)) {
      console.log(`[supatype] Types written to ${typesPath}`)
    } else {
      console.warn("[supatype] Type generation produced no output.")
    }
  } catch (err) {
    console.warn(`[supatype] Type generation failed: ${errorMessage(err)}`)
  }

  writeDevAstOutputs(cwd, ast, config, "")
  await writeDevSeedBuilder(cwd, config, ast, engine)

  try {
    const admin = withAdminRoles(await engineRequest("/admin", { ast }, isAnyAnswer, engine), config)
    restoreSystemRelationTargets(admin, ast)
    writeFileSync(adminConfigPath, `${JSON.stringify(admin, null, 2)}\n`)
    console.log("[supatype] Admin config written to .supatype/admin-config.json")
  } catch (err) {
    console.warn(
      `[supatype] Admin config generation failed, Studio may show stale field widgets: ${errorMessage(err)}`,
    )
  }
}

/**
 * Write the engine's generated types to `typesPath`, from its marker on (the binary can print a
 * banner first). False, with nothing written, when the output holds no types.
 */
function writeEngineTypes(cwd: string, typesPath: string, output: string | undefined): boolean {
  if (output === undefined || !output.includes("export type")) return false
  const marker = output.indexOf("// Generated by supatype-engine")
  const hostPath = join(cwd, typesPath)
  mkdirSync(dirname(hostPath), { recursive: true })
  writeFileSync(hostPath, (marker >= 0 ? output.slice(marker) : output).trimStart())
  return true
}

/**
 * The generated client and augmentation, which need no engine, so they are written whether or not
 * the types step ran or succeeded. This is what `dev` never did: a project developed entirely
 * through `supatype dev` received neither `index.d.ts`, which is what makes `createClient` typed
 * without a generic, nor the field kinds the client reads to keep bigInt, decimal and money
 * columns exact. `suffix` ends each message, naming the engine that ran.
 */
function writeDevAstOutputs(cwd: string, ast: unknown, config: SupatypeProjectConfig, suffix: string): void {
  try {
    for (const message of writeAstDerivedOutputs({ cwd, ast, ...projectOutputPaths(config.output) })) {
      console.log(`[supatype] ${message}${suffix}`)
    }
  } catch (err) {
    console.warn(`[supatype] Generated output failed: ${errorMessage(err)}`)
  }
}

/**
 * The seed builder, from the same engine as the types. Only `generate` wrote it, though the config
 * says dev and push regenerate every output, so after dev's first push it still described the
 * starter models and a seed for anything added since did not typecheck.
 */
async function writeDevSeedBuilder(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
  engine: ComposeEngine | undefined,
): Promise<void> {
  try {
    const message = await writeSeedBuilder({ cwd, ast, engine, ...projectOutputPaths(config.output) })
    if (message !== undefined) console.log(`[supatype] ${message}`)
  } catch (err) {
    console.warn(`[supatype] Seed builder generation failed: ${errorMessage(err)}`)
  }
}

/** How one push treats what needs a person's say. */
export interface ComposePushOptions {
  /** `--overwrite-drift`: put back access changed outside Supatype (plan 3.5). */
  overwriteDrift?: boolean
  /**
   * Apply a change that drops data. Only after a person agreed to it, through
   * `pushConsentingToDestructive`: without it the engine refuses, which is what keeps a rename it
   * did not recognise from emptying a column.
   */
  force?: boolean
  /** The engine's audit flags (`composeAuditArgs`), empty for an engine that does not take them. */
  audit?: readonly string[]
  /**
   * Push without the schema snapshot when it cannot be taken, rather than refuse. dev's, which
   * pushes on every save; `supatype push` refuses ({@link writeSchemaSourcePushArtifacts}).
   */
  snapshotOptional?: boolean
}

/**
 * One push of the schema to a docker project's database, then the files that describe it.
 *
 * Those files (admin-config.json, the generated types and client, the hook and function types,
 * the manifest's hook maps) are written only once the engine has applied the schema. They used to
 * be written first, "so Studio stays in sync even when migration fails", which is the opposite of
 * in sync: a push the engine refused left Studio offering fields the database did not have, and an
 * upload to a field whose bucket was never created answered "Bucket not found". A refusal followed
 * by a forced push also wrote every file twice. Now a refused or failed push rewrites nothing, and
 * Studio and the code keep describing the schema that is live.
 */
export async function runComposeSchemaPush(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
  opts: ComposePushOptions = {},
): Promise<void> {
  const { ast, astJson } = readSchemaToPush(schemaPath, cwd, config)
  _lastReadAst = astJson
  // Before the skip below: the schema-engine container reads the AST through its bind mount.
  writeSchemaAstFile(cwd, astJson)
  // Skipped only while nothing has failed since the last push applied. Putting a refused change
  // back yields the applied schema again, and that still has to reach the engine: the up-to-date
  // push is what marks the refusal superseded and clears Studio's notice. Said out loud, since a
  // save that pushes nothing otherwise ends on "pushing schema..." and looks like a hang.
  if (astJson === _lastPushedAst && _lastFailedAst === null) {
    console.log("[supatype] Schema unchanged since the last push, nothing to apply.")
    return
  }
  // Identity and generated columns only to an engine that reads them (the override's binary is
  // asked by `engineRequest`).
  if (!hasEngineOverride(config)) await requireDockerFeatures(cwd, config, identityColumnsNeed(ast))
  try {
    if (hasEngineOverride(config)) await applyViaHostEngine(cwd, config, ast, opts)
    else await applyViaComposeEngine(cwd, config, { paths, composeProject }, opts)
  } catch (err) {
    _lastFailedAst = astJson
    throw err
  }
  _lastPushedAst = astJson
  _lastFailedAst = null
  if (astRelatesToAuthUsers(ast)) grantAuthSchemaAccess(paths, cwd, composeProject)
  await refreshSchemaArtifacts(cwd, config, ast)
}

/** The schema on disk as a push sends it, and that AST serialized for comparing pushes. */
function readSchemaToPush(
  schemaPath: string,
  cwd: string,
  config: SupatypeProjectConfig,
): { ast: ExtractedSchemaAstV2; astJson: string } {
  const ast = withPublishing(loadSchemaAst(schemaPath, cwd), config)
  return { ast, astJson: JSON.stringify(ast) }
}

/**
 * Whether the schema on disk is not the one the last push read, applied or not: what dev's watch
 * asks when it starts, so a save made while the stack was coming up is still pushed. Throws when
 * the schema cannot be read.
 */
export function schemaChangedSinceLastPush(schemaPath: string, cwd: string, config: SupatypeProjectConfig): boolean {
  return readSchemaToPush(schemaPath, cwd, config).astJson !== _lastReadAst
}

/** The AST the push sends, at `.supatype/schema.ast.json`, where both engines read it. */
function writeSchemaAstFile(cwd: string, astJson: string): void {
  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const astPath = join(supatypeDir, "schema.ast.json")
  writeFileSync(astPath, astJson)
  if (!existsSync(astPath)) throw new Error(`Failed to write schema AST at ${astPath}`)
}

/**
 * Apply `ast` with the host engine binary `overrides.engine` names. Throws when it is not applied.
 * The caller says that a push is starting (push's spinner, dev's watch line), as it does for the
 * compose engine, so this prints only the outcome.
 */
async function applyViaHostEngine(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: ExtractedSchemaAstV2,
  opts: ComposePushOptions,
): Promise<void> {
  await ensureEngine()
  const sources = writeSchemaSourcePushArtifacts(cwd, opts.snapshotOptional === true)
  const body = {
    ast,
    database_url: projectDatabaseUrl(cwd, config),
    schema: pgSchema(config),
    force: opts.force === true,
    ...(opts.overwriteDrift === true && { overwrite_drift: true }),
    ...(sources !== null && {
      schema_sources_gz_base64: sources.payload.dataBase64,
      schema_sources_manifest: sources.payload.manifest,
    }),
  }
  reportAppliedPush(await enginePush(cwd, body, isEnginePushResult))
}

/** Apply the AST on disk with the stack's schema-engine container. Throws when it is not applied. */
async function applyViaComposeEngine(
  cwd: string,
  config: SupatypeProjectConfig,
  stack: { paths: SelfHostComposePaths; composeProject: string },
  opts: ComposePushOptions,
): Promise<void> {
  const { paths, composeProject } = stack
  const sources = writeSchemaSourcePushArtifacts(cwd, opts.snapshotOptional === true)
  const audit = opts.audit ?? (await composeAuditArgs(cwd, config))
  const pushOnce = () => runComposeEnginePush(paths, cwd, composeProject, config, sources, { ...opts, audit })
  const runPush = async () => {
    const first = await pushOnce()
    // Windows Docker bind mounts can lag briefly after the host write. A consent refusal is the
    // engine's considered answer, not a lagging mount, and running it again only repeats it.
    if (first.status === 0 || consentRefusal(first.output) !== null) return first
    await new Promise((r) => setTimeout(r, 250))
    return pushOnce()
  }
  // B: only hold the advisory lock when realtime is already decoding, first-boot
  // push (db only) must not take the lock; that path crashed under lock+DDL in CI.
  const push = composeServiceIsRunning(cwd, { composePath: paths.composePath, project: composeProject }, "realtime")
    ? await withComposeSchemaPushLock(paths, cwd, composeProject, runPush)
    : await runPush()
  if (push.status === 0) return
  const detail = filterComposeNoise(push.output) || push.output
  throw new Error(detail || `Engine schema push failed (exit ${push.status})`)
}

/** Serialize watch-triggered pushes so docker output cannot interleave. */
async function runComposeSchemaPushQueued(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
  opts: ComposePushOptions = {},
): Promise<void> {
  if (_composePushInFlight) {
    _composePushQueued = true
    return
  }
  _composePushInFlight = true
  try {
    do {
      _composePushQueued = false
      await runDevSchemaPush(cwd, config, paths, schemaPath, composeProject, opts)
    } while (_composePushQueued)
    followRecordedTier(cwd, config, { recreate: true })
  } finally {
    _composePushInFlight = false
  }
}

/**
 * Point PostgREST at the field-masking tier the database recorded on the push just made, when it
 * serves differently from what compose was written with (T2-N6): `dev` and `push` predict the tier
 * from the image, and a database without `supatype_mask` runs tier 2 whatever its image is. The
 * record is kept either way, and compose is rendered again from it. With `recreate`, PostgREST is
 * recreated so a running stack serves the new search path now; a caller about to run
 * `compose up -d` leaves that to it.
 */
export function followRecordedTier(
  cwd: string,
  config: SupatypeProjectConfig,
  opts: { recreate: boolean },
): void {
  if (usesExternalDatabase(config)) return
  const project = composeProjectName(config.project.name)
  const paths = selfHostComposePaths(cwd)
  const served = composeFieldMaskingTier(cwd, config)
  const recorded = recordDatabaseTier(cwd, { project, composePath: paths.composePath })
  if (recorded === undefined || sameApiSurface(config, served, recorded)) return
  writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
  console.log(`[supatype] The database runs field masking tier "${recorded}"; PostgREST follows it.`)
  if (!opts.recreate) return
  const status = runDockerCompose(paths.composePath, ["up", "-d", "--no-deps", "postgrest"], cwd, project, {
    quiet: true,
  })
  if (status !== 0) {
    console.warn(`[supatype] Could not recreate PostgREST for the new tier (exit ${status}). Restart dev to apply it.`)
  }
}

/**
 * One push of a `dev` session, initial or on save. Never forced: a change that would drop data, or
 * one that would put back access changed outside Supatype, is asked about in a terminal as `push`
 * asks it, and refused anywhere else; a refusal or a no leaves dev running.
 */
async function runDevSchemaPush(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
  opts: ComposePushOptions,
): Promise<void> {
  const audit = opts.audit ?? (hasEngineOverride(config) ? [] : await composeAuditArgs(cwd, config))
  const once = (overwriteDrift: boolean) =>
    pushConsentingToDestructive(
      (force) =>
        runComposeSchemaPush(cwd, config, paths, schemaPath, composeProject, {
          ...opts,
          audit,
          overwriteDrift,
          force,
          snapshotOptional: true,
        }),
      DEV_DESTRUCTIVE_POLICY,
      consentDepsFromDiff(cwd, () => dockerDiff(cwd, config)),
    )
  return devPushConsentingToDrift(once, opts.overwriteDrift === true, {
    beforeOverwrite: () => requireDockerFeatures(cwd, config, [OVERWRITE_DRIFT_NEED]),
  })
}

/**
 * A diff of the schema just pushed against the stack's database, for the questions a refused push
 * asks: the engine's refusal gives only a count, not what would be lost or which drops and adds
 * may be renames. Reads the AST the push wrote, so it is the schema that was refused.
 */
export async function dockerDiff(cwd: string, config: SupatypeProjectConfig): Promise<DiffResult | undefined> {
  if (hasEngineOverride(config)) {
    const ast = JSON.parse(readFileSync(join(cwd, ".supatype", "schema.ast.json"), "utf8"))
    return engineRequest(
      "/diff",
      { ast, database_url: projectDatabaseUrl(cwd, config), schema: pgSchema(config) },
      isDiffResult,
    )
  }
  const project = composeProjectName(config.project.name)
  const result = await runComposeEngineDiff(selfHostComposePaths(cwd), cwd, project, config)
  return result.diff ?? undefined
}

/**
 * The compose engine's audit flags, for an image that records them (`push_audit`). Asked once per
 * command and passed to every attempt through `ComposePushOptions.audit`: each ask costs a
 * `docker` run.
 */
export async function composeAuditArgs(cwd: string, config: SupatypeProjectConfig): Promise<string[]> {
  return auditFlags((await auditWhenSupported(cwd, () => dockerEngineCapabilities(cwd, config))) ?? {})
}

/** The schema AST as the `schema-engine` container sees it, under the project mount. */
const COMPOSE_SCHEMA_AST = "/project/.supatype/schema.ast.json"

async function runComposeEnginePush(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  sources?: SchemaSourcePushArtifacts | null,
  opts: ComposePushOptions = {},
): Promise<{ status: number; output: string }> {
  const { output, status: exitStatus } = await runComposeEngine(
    paths,
    cwd,
    composeProject,
    config,
    composeEnginePushArgs(sources, opts),
  )
  const pushResult = parseEnginePushOutput(output)

  if (exitStatus === 0) {
    if (pushResult) {
      reportAppliedPush(pushResult)
    } else {
      console.log("[supatype] Schema applied.")
    }
  }

  return { status: exitStatus, output }
}

/**
 * What the engine a docker project runs supports: the local binary when `overrides.engine` is set,
 * otherwise the compose schema-engine image, asked in a throwaway container.
 */
export async function dockerEngineCapabilities(cwd: string, config: SupatypeProjectConfig): Promise<Capabilities> {
  if (hasEngineOverride(config)) return engineCapabilities()
  const engineImage = await schemaEngineImageForPush(config, cwd)
  // An image Docker could not pull throws with the daemon's sentence, and is asked again next time.
  const probe = (): Capabilities => {
    const paths = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
    const target = { cwd, project: composeProjectName(config.project.name), composePath: paths.composePath, engineImage }
    return probeCapabilities((args) => {
      const run = spawnComposeEngine(target, args, { runFlags: ["--no-deps"] })
      return { status: run.status, stdout: run.stdout ?? "", stderr: run.error?.message ?? run.stderr ?? "" }
    })
  }
  const imageId = engineImage === undefined ? "compose-default" : localImageId(engineImage)
  // Not pulled yet: the probe pulls it, and the next call keys on the ID it then has.
  if (imageId === undefined) return probe()
  return rememberCapabilitiesSync(dockerCapabilities, `${cwd}\0${engineImage ?? ""}\0${imageId}`, probe)
}

/**
 * The local image's ID, or undefined when Docker does not have it. The answer is keyed on it, so
 * a tag that now names another image (a pull, a rebuild) is asked again, and nothing else is.
 */
function localImageId(image: string): string | undefined {
  const inspect = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8" })
  const id = inspect.status === 0 ? inspect.stdout.trim() : ""
  return id === "" ? undefined : id
}

/** Answers per project and engine image ID (`rememberCapabilitiesSync`): each probe costs a container. */
const dockerCapabilities: CapabilitiesCache<Capabilities> = capabilitiesCache()

/** Refuse, before anything is sent, an ownership feature the docker project's engine lacks. */
export async function requireDockerFeatures(
  cwd: string,
  config: SupatypeProjectConfig,
  needs: readonly FeatureNeed[],
): Promise<void> {
  if (needs.length === 0) return
  assertSupported(await dockerEngineCapabilities(cwd, config), needs)
}

/** The compose schema-engine's `push` arguments, after the service name. Exported for its tests. */
export function composeEnginePushArgs(
  sources: SchemaSourcePushArtifacts | null | undefined,
  opts: ComposePushOptions = {},
): string[] {
  const args = [
    "push",
    "-i",
    COMPOSE_SCHEMA_AST,
    // The container has no terminal to ask on: the CLI asks, and forces only on a yes.
    "--non-interactive",
  ]
  if (opts.force === true) args.push("--force")
  // Only when asked: an engine older than the ledger rejects the flag.
  if (opts.overwriteDrift === true) args.push("--overwrite-drift")
  if (sources) {
    args.push(
      "--schema-sources-gz",
      sources.dockerGzPath,
      "--schema-sources-manifest",
      sources.dockerManifestPath,
    )
  }
  args.push(...(opts.audit ?? []))
  return args
}

/** One engine run: its exit, what it printed on stdout alone, and everything it printed. */
export interface EngineRun {
  status: number
  stdout: string
  output: string
}

/**
 * The adopt result from one engine run, or null when there is none to read.
 *
 * From stdout alone. The engine prints the preview as multi-line JSON, which only parses as a
 * whole, and with stderr joined on (a compose warning about an unset variable, an engine log line)
 * it did not parse at all, so a preview that worked was reported as a failed adopt.
 */
export function adoptResultFrom(run: EngineRun): AdoptOutcome | null {
  return run.status === 0 ? parseEngineJsonOutput(run.stdout, isAdoptOutcome) : null
}

/**
 * One schema-engine subcommand in the compose `tools` profile, against the stack's own database.
 *
 * In a container, so it reaches Postgres at the compose-internal address and needs nothing
 * published to the host. That is what a host-side `supatype adopt` got wrong on a docker project
 * (supatype#85), and why the push walkthrough runs adopt this way instead.
 */
async function runComposeEngineCommand(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  command: readonly string[],
): Promise<EngineRun> {
  const schema = pgSchema(config)
  const engineArgs = [...command, "-i", COMPOSE_SCHEMA_AST, "--schema", schema]
  return runComposeEngine(paths, cwd, composeProject, config, engineArgs)
}

/**
 * Run the engine with `engineArgs` in the compose `tools` profile, against the stack's database.
 *
 * The database URL carries the password, so it reaches the engine as `DATABASE_URL` through a
 * bare `-e`, with the value in docker's environment rather than on its command line.
 */
async function runComposeEngine(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  engineArgs: readonly string[],
): Promise<EngineRun> {
  const engineImage = await schemaEngineImageForPush(config, cwd)
  const target = { cwd, project: composeProject, composePath: paths.composePath, engineImage }
  const result = spawnComposeEngine(target, engineArgs, {
    secrets: { DATABASE_URL: projectDatabaseUrl(cwd, config, true) },
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  }
}

async function runComposeEngineDiff(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
): Promise<{ status: number; output: string; diff: DiffResult | null }> {
  const result = await runComposeEngineCommand(paths, cwd, composeProject, config, ["diff"])
  return { ...result, diff: parseEngineJsonOutput(result.output, isDiffResult) }
}

/**
 * The compose schema-engine's `adopt` arguments. `keys: []` is "adopt none", which the binary
 * spells `--adopt-none`: no `--key` at all would adopt every conflict. Exported for its tests.
 */
export function adoptCommand(yes: boolean, keys?: readonly string[]): string[] {
  if (!yes) return ["adopt"]
  if (keys === undefined) return ["adopt", "--yes"]
  if (keys.length === 0) return ["adopt", "--yes", "--adopt-none"]
  return ["adopt", "--yes", ...keys.flatMap((k) => ["--key", k])]
}

/** Adoption against a docker project's own database, for the push walkthrough. */
export function dockerAdoptionSteps(cwd: string, config: SupatypeProjectConfig): AdoptionSteps {
  return targetAdoptionSteps(
    (yes, keys) => adoptSchemaDocker(cwd, config, yes, keys),
    (keys) => requireDockerFeatures(cwd, config, [adoptKeysNeed(keys)]),
  )
}

/**
 * Adopt on a docker project's own database: the preview, or with `yes`, the ledger rows written,
 * for only the conflicts `keys` names when it is given (as a preview listed them).
 *
 * Through the compose schema-engine, or the local engine binary when `overrides.engine` is set,
 * the same way `diffSchemaDocker` reaches the database. The stack's database must be running,
 * which it is whenever a push has just been refused by it.
 */
export async function adoptSchemaDocker(
  cwd: string,
  config: SupatypeProjectConfig,
  yes: boolean,
  keys?: string[],
): Promise<AdoptOutcome> {
  const project = composeProjectName(config.project.name)
  // Only these conflicts, or none for an empty list: never sent to an engine that would read
  // either as "every conflict".
  if (keys !== undefined) await requireDockerFeatures(cwd, config, [adoptKeysNeed(keys)])
  if (hasEngineOverride(config)) {
    await ensureDockerDbPublishedForHostEngine(cwd, config, { intro: "Adopt" })
    await ensureEngine()
    return engineRequest(
      "/adopt",
      {
        ast: withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config),
        database_url: projectDatabaseUrl(cwd, config),
        schema: pgSchema(config),
        yes,
        ...(keys !== undefined && { keys }),
      },
      isAdoptOutcome,
    )
  }
  await requireDockerFeatures(
    cwd,
    config,
    identityColumnsNeed(withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)),
  )
  const paths = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
  const command = adoptCommand(yes, keys)
  const result = await runComposeEngineCommand(paths, cwd, project, config, command)
  const parsed = adoptResultFrom(result)
  if (parsed === null) {
    throw new Error(filterComposeNoise(result.output) || `Engine adopt failed (exit ${result.status})`)
  }
  return parsed
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
  if (hasEngineOverride(config)) {
    const brand = { intro: "Schema diff" }
    await ensureDockerDbPublishedForHostEngine(cwd, config, brand)
    const schemaPath = schemaPathFromProject(config, cwd)
    const ast = withPublishing(loadSchemaAst(schemaPath, cwd), config)
    await ensureEngine()
    return engineRequest(
      "/diff",
      { ast, database_url: projectDatabaseUrl(cwd, config), schema: pgSchema(config) },
      isDiffResult,
    )
  }

  // A diff of a standalone stack must not write dev values over the operator's .env (SH1).
  const mode = composeRenderMode(cwd, config.project.name)
  if (mode === "dev") {
    const { anonKey, serviceRoleKey } = devApiKeys(cwd)
    ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, await resolveKongPort(cwd, project), undefined)
  }

  const paths = writeSelfHostCompose(cwd, config, { devLocal: mode === "dev" })
  const diffBrand = { intro: "Schema diff" }

  await startComposeDatabase(config, paths, cwd, project, diffBrand)

  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = withPublishing(loadSchemaAst(schemaPath, cwd), config)
  await requireDockerFeatures(cwd, config, identityColumnsNeed(ast))

  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const astPath = join(supatypeDir, "schema.ast.json")
  writeFileSync(astPath, JSON.stringify(ast))

  let result = await runComposeEngineDiff(paths, cwd, project, config)
  // Windows Docker bind mounts can lag briefly after the host write.
  if (result.status !== 0) {
    await new Promise((r) => setTimeout(r, 250))
    result = await runComposeEngineDiff(paths, cwd, project, config)
  }
  if (result.status !== 0) {
    const detail = filterComposeNoise(result.output) || result.output
    throw new Error(detail || `Engine schema diff failed (exit ${result.status})`)
  }
  if (!result.diff) {
    // The engine exited 0 and produced nothing this could parse, which is a different failure from
    // the engine exiting non-zero and is the harder one to act on. "Engine diff returned no result"
    // named only the symptom, and running the same compose command by hand gave a clear error in
    // one go, so the message was the only thing standing between the reader and the answer.
    const output = (filterComposeNoise(result.output) || result.output || "").trim()
    throw new Error(
      output === ""
        ? "The schema engine exited 0 and printed nothing. Run `supatype self-host compose run --rm schema-engine diff` to see what it does."
        : `The schema engine exited 0 but its output could not be parsed as a diff:\n${output}`,
    )
  }
  return result.diff
}

/**
 * `supatype push` when `provider: docker`. Uses in-compose schema-engine unless
 * `overrides.engine` is set: then Postgres is published to the host and push runs
 * through the local engine binary (AST v2, contributor builds).
 */
export async function pushSchemaDocker(
  cwd: string,
  config: SupatypeProjectConfig,
  opts: ComposePushOptions = {},
): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("pushSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  // The stack's own mode, never dev by default: a push to a production stack used to render it as
  // dev and recreate it that way, and write dev values over the operator's .env (SH1). A host
  // engine is handed the database derived from the running stack, so with none running it refuses
  // before anything starts (M1b).
  const hostEngineDerivesDb = hasEngineOverride(config) && !usesExternalDatabase(config)
  const mode = hostEngineDerivesDb
    ? requireRunningStack(cwd, config.project.name)
    : composeRenderMode(cwd, config.project.name)
  const kongPort = await resolveKongPort(cwd, project)
  if (mode === "dev") await prepareDevComposeEnv(cwd, config, project, kongPort)
  const gatewayPort = composeGatewayHostPort(config, mode, kongPort)
  const { anonKey, serviceRoleKey } = devApiKeys(cwd)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: mode === "dev" })
  const pushBrand = { intro: "Push schema" }

  await startComposeDatabase(config, paths, cwd, project, pushBrand)
  if (!usesExternalDatabase(config)) privatizeTableDefaults(paths, cwd, project)

  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = withPublishing(loadSchemaAst(schemaPath, cwd), config)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project, opts)
  // `up -d` below recreates PostgREST when the tier changed its environment.
  followRecordedTier(cwd, config, { recreate: false })

  await bringPushedStackUp(cwd, config, { paths, project, gatewayPort, brand: pushBrand }, ast, {
    anonKey,
    serviceRoleKey,
  })
  console.log("[supatype] Schema pushed.")
}

/**
 * The host port the stack's gateway answers plain HTTP on. A standalone stack with TLS publishes
 * Kong on 80 and 443 instead of SUPATYPE_KONG_PORT. Before SH1 a push never met one: it turned every
 * stack into dev, and dev never has TLS, first.
 */
export function composeGatewayHostPort(
  config: SupatypeProjectConfig,
  mode: ComposeRenderMode,
  kongPort: number,
): number {
  return selfHostTlsEnabled(config, mode === "dev") ? 80 : kongPort
}

/**
 * After a compose push: the rest of the stack up, then what the schema asks of it once it answers
 * (buckets, the first admin), then REST, which is the last to catch up with the new schema.
 */
async function bringPushedStackUp(
  cwd: string,
  config: SupatypeProjectConfig,
  stack: { paths: SelfHostComposePaths; project: string; gatewayPort: number; brand: DockerBrandOptions },
  ast: ExtractedSchemaAstV2,
  keys: { anonKey: string; serviceRoleKey: string },
): Promise<void> {
  const { paths, project, gatewayPort, brand } = stack
  const upGateway = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project, { quiet: true, brand })
  if (upGateway !== 0) {
    exitComposeFailed(upGateway, "Could not start the Compose gateway stack.", brand)
  }
  await waitKongReady(gatewayPort, 120, { composePath: paths.composePath, cwd, project })
  await waitStorageApiReady(gatewayPort, keys.serviceRoleKey, 90)
  await provisionDockerStorageBuckets(ast, gatewayPort, keys.serviceRoleKey)

  await ensureFirstAdminUserForProject(cwd, config, {
    compose: { project, composePath: paths.composePath },
  })

  // Last, so the admin user and the buckets are not held up by it. `supatype dev` never comes
  // through here: it pushes before PostgREST starts, so PostgREST finds the schemas on its first try.
  await waitForRestReady(loopbackBase(gatewayPort), keys.anonKey)
}

/**
 * The first push of a `dev` session. A retry only ever brings Postgres back up: it never removes
 * a volume, so a refused push leaves the developer's database exactly as it found it.
 */
async function applyInitialSchema(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  project: string,
  brand: DockerBrandOptions,
  opts: ComposePushOptions = {},
): Promise<boolean> {
  const steps: InitialPushSteps = {
    push: () => runDevSchemaPush(cwd, config, paths, schemaPath, project, opts),
    recoverDatabase: () => startComposeDatabase(config, paths, cwd, project, brand, undefined, endDevSession),
    dumpLogs: (reason) => dumpComposeDbLogs(paths, cwd, project, reason),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
  const outcome = await adoptingOnRefusal(await pushInitialSchema(steps), steps, cwd, config)
  // Ending the session before an exit, so its message reaches the real terminal rather than a TUI
  // that is going away.
  return settleInitialPush(outcome, { brand, beforeExit: endDevSession })
}

/**
 * On an unmanaged-tables refusal, offer adoption and push once more. Offered rather than only
 * named: the stack's database is up, so adoption can run against it here, and a push straight
 * after it is the one that was just refused.
 */
async function adoptingOnRefusal(
  outcome: InitialPushOutcome,
  steps: InitialPushSteps,
  cwd: string,
  config: SupatypeProjectConfig,
): Promise<InitialPushOutcome> {
  if (outcome.kind !== "refused" || outcome.refusal?.kind !== "unmanaged-tables") return outcome
  const adopted = await offerAdoption(outcome.refusal.tables, dockerAdoptionSteps(cwd, config), {
    yes: false,
    retry: "supatype dev",
  })
  return adopted === "adopted" ? pushInitialSchema(steps) : outcome
}

export async function runDevCompose(cwd: string, config: SupatypeProjectConfig, opts: DevComposeOptions): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("runDevCompose requires provider: docker")
  }
  // dev is what makes a stack dev. Claimed first, so every render this process makes on the way up
  // and after it is dev, before the session's lock file exists (see compose-render-mode.ts).
  claimDevRenderMode()

  // Per-project compose name + port isolate this project from any other Supatype
  // stack on the machine (own containers, volumes, network, and gateway port).
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd, project)
  // No dev db port for an external database: `ensureDevDbPort` allocates a host port for the `db`
  // container *and persists a matching DATABASE_URL*, which overwrote the operator's own URL, the
  // one the whole stack and every CLI command reads.
  // Whatever compose publishes, `DATABASE_URL` has to point at. Gating this on
  // `overrides.engine` while the compose file published unconditionally is what left a project
  // with a database on 54329 and a URL still saying 5432.
  // Only dev moves the port off something else that holds it.
  const devDbPort = publishesDbToHost(config)
    ? await ensureDevDbPort(cwd, { composeProject: project, mayMove: true })
    : undefined

  const { anonKey, serviceRoleKey } = devApiKeys(cwd)

  const devBrand = { intro: "Local development" }
  const localServerImage = await ensureLocalServerDockerImage(cwd, config, devBrand)

  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)
  warnProjectAuthProviderSecrets(cwd, config)

  console.log(`[supatype] provider docker, starting self-host Compose stack (project ${project}, gateway :${kongPort})...`)
  const paths = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
  if (ensureDevApiConfig(cwd)) {
    console.log("[supatype] API config written to .supatype/api-config.json")
  }

  type StudioProc = Awaited<ReturnType<typeof startStudioViteDevServer>>
  type AppProc = ReturnType<typeof startProxyDevApp>
  const shutdownState: {
    studioProc: StudioProc
    appProc: AppProc
    schemaWatcher: { close: () => void } | null
    functionsWatcher: { close: () => void } | null
  } = {
    studioProc: null,
    appProc: null,
    schemaWatcher: null,
    functionsWatcher: null,
  }

  registerDevShutdown(async () => {
    shutdownState.schemaWatcher?.close()
    shutdownState.schemaWatcher = null
    shutdownState.functionsWatcher?.close()
    shutdownState.functionsWatcher = null
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
  await handleComposeProjectRename(cwd, projectNameInFile(config), paths)

  // Only on request, and before Postgres starts, so it comes up on an empty volume.
  if (opts.resetDb) {
    await resetDevDatabase(
      {
        composePath: paths.composePath,
        cwd,
        project,
        external: usesExternalDatabase(config),
        brand: devBrand,
        onFailure: endDevSession,
      },
      { yes: opts.yes },
    )
  }

  if (!usesExternalDatabase(config)) {
    console.log("[supatype] Bringing up Postgres (compose db)...")
  }
  await startComposeDatabase(config, paths, cwd, project, devBrand, 180_000, endDevSession)
  // Settle before DDL: pg_isready can pass slightly before the instance is stable.
  await new Promise((r) => setTimeout(r, 3000))

  if (!usesExternalDatabase(config)) {
    reconcileAuthenticatorPassword(paths, cwd, project)
    reconcileSqlEditorPassword(paths, cwd, project)
    privatizeTableDefaults(paths, cwd, project)
  }

  // A: apply schema before realtime (and the rest of the stack) starts decoding WAL.
  const schemaPath = schemaPathFromProject(config, cwd)
  // `dev --overwrite-drift`, already checked against this engine before the session began.
  const pushOptions: ComposePushOptions = { overwriteDrift: opts.overwriteDrift === true }
  const schemaApplied = await applyInitialSchema(cwd, config, paths, schemaPath, project, devBrand, pushOptions)
  // Before the stack starts, so PostgREST comes up on the tier the push actually produced.
  followRecordedTier(cwd, config, { recreate: false })

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

  // A service whose image is pinned in `.env` is recreated once the stack is up, so a contributor
  // can point at a build from this checkout rather than the published tag.
  //
  // Storage was missing from this list, which is why a storage bug survived: there was no way to
  // run the suite against a local storage build, so every integration run tested the last release
  // no matter what the working tree said.
  for (const service of ["realtime", "storage"] as const) {
    const variable = `SUPATYPE_${service.toUpperCase()}_IMAGE`
    if (readEnvValue(cwd, variable, "").trim() === "") continue
    console.log(`[supatype] Recreating ${service} with pinned image...`)
    const status = runDockerCompose(
      paths.composePath,
      ["up", "-d", "--force-recreate", "--no-deps", service],
      cwd,
      project,
      { quiet: true, brand: devBrand },
    )
    if (status !== 0) {
      endDevSession()
      exitComposeFailed(status, `Could not recreate the ${service} container.`, devBrand)
    }
  }

  // `up -d` recreates `db` when its definition changed since Postgres was started above for the
  // schema push (a new image on upgrade, a different host port). Postgres then restarts under the
  // services just started, and the admin seed and bucket provisioning below met "the database
  // system is starting up" while the panel said the stack was running. Wait for it again: on a db
  // that was left alone this returns at once.
  if (!usesExternalDatabase(config)) {
    await waitForDatabaseAfterUp({
      waitHealthy: () => waitComposeHealthy(paths, cwd, 180_000, project),
      dumpLogs: (reason) => dumpComposeDbLogs(paths, cwd, project, reason),
      onFailure: endDevSession,
      brand: devBrand,
    })
  }

  console.log("[supatype] Waiting for API gateway...")
  await waitKongReady(kongPort, 120, { composePath: paths.composePath, cwd, project })
  console.log("[supatype] Waiting for storage API...")
  await waitStorageApiReady(kongPort, serviceRoleKey, 90)

  await ensureFirstAdminUserForProject(cwd, config, {
    compose: { project, composePath: paths.composePath },
  })

  writeLocalEnvironment(cwd, {
    target: "local",
    apiUrl: `http://localhost:${kongPort}`,
    databaseUrl: projectDatabaseUrl(cwd, config, !hasEngineOverride(config)),
    // The file's name: this outlives the run, and a run under SUPATYPE_PROJECT_NAME is not a rename.
    projectRef: projectNameInFile(config),
    kongPort,
    provider: "docker",
  })

  writeDevSessionLock(
    cwd,
    devSessionLockFor(config, { composeProject: project, composePath: paths.composePath, kongPort }),
  )

  // Only for a schema the database took, as a save does: a refused one may not even load, and its
  // buckets belong to fields that do not exist yet. The save that applies it provisions them.
  if (schemaApplied) {
    const ast = withPublishing(loadSchemaAst(schemaPath, cwd), config)
    await provisionDockerStorageBuckets(ast, kongPort, serviceRoleKey)
  }

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
      anonKey,
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
  links.push({ label: "Studio", url: studioUrlAt(`http://localhost:${kongPort}`) })

  const hints: string[] = []
  const demoData = demoDataHint(cwd)
  if (demoData !== undefined) hints.push(demoData)

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
    shutdownState.schemaWatcher = watchDevSchema({
      dir: schemaDir,
      changedSinceLastPush: () => schemaChangedSinceLastPush(schemaPath, cwd, config),
      push: (why) => {
        console.log(`\n[supatype] ${why}, pushing schema...`)
        runComposeSchemaPushQueued(cwd, config, paths, schemaPath, project, pushOptions)
          .then(async () => {
            const updatedAst = loadSchemaAst(schemaPath, cwd)
            await provisionDockerStorageBuckets(updatedAst, kongPort, serviceRoleKey)
          })
          .catch(reportDevPushFailure)
      },
    })
    // The worker imports its handlers once; without this an edited function kept its old code.
    const worker = { composePath: paths.composePath, cwd, project }
    shutdownState.functionsWatcher = watchFunctionSources(cwd, () => restartComposeFunctionsWorker(worker))
  }

  // Until Ctrl+C or a signal: the shutdown hook takes the stack down and exits.
  await waitForDevShutdown()
}

/**
 * Run one read-only generator in the in-compose schema-engine and return its stdout.
 *
 * The same image and the same bind mount the push just used, so if the schema could be applied
 * this can run. It exists because the host engine is a separate binary fetched from a CDN, and a
 * machine that cannot fetch it is not a machine that cannot generate: the schema is already
 * applied, the AST is already on disk, and the container that did it is one `docker compose run`
 * away.
 */
async function runComposeEngineGenerator(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  args: readonly string[],
): Promise<string | null> {
  const engineImage = await schemaEngineImageForPush(config, cwd)
  const target = { cwd, project: composeProject, composePath: paths.composePath, engineImage }
  const result = spawnComposeEngine(target, [...args, "-i", COMPOSE_SCHEMA_AST], {
    runFlags: ["-T"],
    maxBuffer: 20 * 1024 * 1024,
  })
  if ((result.status ?? 1) !== 0) return null
  return String(result.stdout ?? "")
}

/**
 * The in-compose engine as {@link engineRequest} takes it, for generating only. No database URL:
 * `/generate` reads the AST alone and runs without starting the database.
 */
async function composeGeneratorEngine(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
): Promise<ComposeEngine> {
  const engineImage = await schemaEngineImageForPush(config, cwd)
  return {
    target: { cwd, project: composeProject, composePath: paths.composePath, engineImage },
    databaseUrl: "",
    capabilities: () => dockerEngineCapabilities(cwd, config),
  }
}

/**
 * Write `admin-config.json` and the generated types using the in-compose engine.
 *
 * The fallback for a host engine that could not be fetched. Without it, a `supatype dev` that
 * applied the schema perfectly well still left no `admin-config.json`, and Studio reads that file
 * to decide whether a schema exists: the stack came up, every table was live, the API served them,
 * and Studio said **"No schema has been pushed yet."** The warning that preceded it named the
 * download, not the consequence, so nothing connected the two.
 *
 * Returns true when the admin config was written, which is the file Studio actually needs.
 */
export async function generateViaComposeEngine(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  config: SupatypeProjectConfig,
  ast: unknown,
  adminConfigPath: string,
): Promise<boolean> {
  const { typesPath } = projectOutputPaths(config.output)
  const out = await runComposeEngineGenerator(paths, cwd, composeProject, config, ["generate"])
  if (writeEngineTypes(cwd, typesPath, out ?? undefined)) {
    console.log(`[supatype] Types written to ${typesPath} (in-compose engine).`)
  }

  // The same AST-derived files as the host path. This is the fallback used when the host engine
  // could not be fetched, and these need no engine at all, so there is no reason for a project on
  // this path to end up with fewer generated files than one on the other.
  writeDevAstOutputs(cwd, ast, config, " (in-compose engine).")
  await writeDevSeedBuilder(cwd, config, ast, await composeGeneratorEngine(paths, cwd, composeProject, config))

  const adminOut = await runComposeEngineGenerator(paths, cwd, composeProject, config, ["admin"])
  if (!adminOut) return false
  const parsed = parseEngineJsonOutput(adminOut, isObjectAnswer)
  if (parsed === null) return false

  const admin = withAdminRoles(parsed, config)
  restoreSystemRelationTargets(admin, ast)
  writeFileSync(adminConfigPath, `${JSON.stringify(admin, null, 2)}\n`)
  console.log("[supatype] Admin config written to .supatype/admin-config.json (in-compose engine).")
  return true
}
