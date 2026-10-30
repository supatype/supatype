/**
 * supatype dev: start local Postgres, apply schema, run supatype-server.
 *
 * Runtime provider (top-level `provider` or legacy `database.provider`):
 *   docker: full self-host Compose stack (Kong on SUPATYPE_KONG_PORT); see dev-compose.ts (default)
 *   native: host Postgres + host server + host engine
 *
 * Edge functions (when a functions/ dir exists): Deno is resolved from the CDN cache
 * (auto-download on miss). Self-host/cloud Docker stacks use supatype-server in-container;
 * Deno is not provisioned by the CLI on those paths.
 */

import { reportAppliedPush } from "../engine-push-output.js"
import { errorMessage } from "../error-message.js"
import type { DiffResult } from "../engine-client.js"
import { isDiffResult, isEnginePushResult } from "../engine-answers.js"
import type { DestructiveConsentDeps } from "../destructive-consent.js"
import { reportDevPushFailure } from "../push-refusal.js"
import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { hasEnvValue, readDotEnvFiles } from "../env-file.js"
import { requireUrlSafeComposePasswords } from "../url-safe-passwords.js"
import { loadConfig } from "../config.js"
import type { ExtractedSchemaAstV2, FieldAstV2, ModelAstV2 } from "../schema-ast-v2.js"
import {
  bucketSpecsFromAst,
  isParsedBuckets,
  nativeBucketRow,
  provisionBuckets,
  withPublicFromMode,
  type ParsedStorageBucket,
} from "../storage-provision.js"
import { readJsonFile } from "../json-file.js"
import { isArrayOf, isJsonObject } from "@supatype/shared"
import {
  pgSchema,
  functionsPathCandidatesFromProject,
  hooksPathFromProject,
  preferredFunctionsPathFromProject,
  localDSN,
  nativeDataDir,
  nativeDbPort,
  nativeRealtimePort,
  nativeDenoPort,
  nativeStoragePort,
  STORAGE_PORT_ENV,
  DENO_PORT_ENV,
  nativeStateRoot,
  nativeServerPort,
  REALTIME_PORT_ENV,
  resolveRuntimeProvider,
  schemaPathFromProject,
  type SupatypeProjectConfig,
} from "../project-config.js"
import { DEV_DB_PORT_ENV } from "../db-port.js"
import { functionsWorkerEnv, installFunctionsWorker, localWorkerRoutesOrExit, writeDevFunctionsEntry } from "../functions-worker-files.js"
import { devServiceRoleKeyPath } from "../service-role-key-file.js"
import { requireUsableJwtSecret } from "../jwt-secret-length.js"
import {
  ensureNativeAuthenticatorPassword,
  devJwtSecret,
  ensureNativeSuperuserPassword,
  givenJwtSecret,
  ignoredJwtSecretWarning,
  secretFingerprint,
} from "../local-secrets.js"
import {
  normalisePlatformPath,
  cachePath,
  currentPlatform,
  hasMeaningfulOverrides,
  describeActiveOverrides,
  postgresArchiveTag,
} from "../binary-cache.js"
import { ensureBinary } from "../ensure-binary.js"
import {
  assertSupported,
  binaryCapabilities,
  EngineProbeFailed,
  OVERWRITE_DRIFT_NEED,
  OwnershipUnsupportedError,
  requireEngineFeatures,
} from "../engine-ownership-gate.js"
import { startProxyDevApp } from "../app/proxy-dev-app.js"
import { ProcessManager } from "../process-manager.js"
import {
  markPostgrestUnpacked,
  POSTGREST_VERSION,
  postgrestArchiveName,
  postgrestArchiveUrl,
  postgrestRuntimeRepairDue,
} from "../postgrest-release.js"
import { STUDIO_DEV_PORT, startStudioViteDevServer } from "../studio-dev-server.js"
import { restoreSystemRelationTargets } from "../restore-system-relation-targets.js"
import { beginDevSession, endDevSession, resolveDevUiMode, startDevSession } from "../dev-session.js"
import { publishDevReady } from "../dev-ready-panel.js"
import { probeDockerDaemon, reportDockerUnavailable } from "../docker-runtime.js"
import { fatalError } from "../ui/fatal.js"
import {
  haltIfStopping,
  pushStartUndo,
  pushStartUndoLast,
  registerDevShutdown,
  stopQuietlyDuringStart,
  waitForDevShutdown,
} from "../dev-shutdown.js"
import { startNativeRealtime } from "../native-realtime.js"
import { patchRouteManifest, recordNativeRoutes } from "../route-manifest.js"
import { reconcileNativeDevDatabaseUrl } from "../db-port-offer.js"
import { extractArchive } from "../archive-extract.js"
import { serverStorageEnv, startNativeStorage } from "../native-storage.js"
import { keepsObjectsLocally, serverStoreRoot } from "../local-storage.js"
import { writeAppliedAstArtifacts } from "../applied-ast-artifacts.js"
import { writeAppViteEnv } from "../app-vite-env.js"
import { nativeAuthProviderEnv, warnMissingAuthProviderSecrets } from "../auth-providers.js"
import { AUTHENTICATOR_PASSWORD_ENV } from "../native-roles-sql.js"
import {
  nativeAuthMailerEnv,
  nativeDevApiKeys,
  nativeDevRolesSql,
  nativePostgrestSchemaEnv,
  nativeServerCoreEnv,
  nativeServerDotEnvLayer,
} from "../native-dev-env.js"
import { ensureValkeySidecar, externalValkey, type ValkeySidecarResult } from "../valkey-sidecar.js"
import { nativeKeyspaceAddr as nativeKeyspaceAddrFor, nativeKeyspacePort } from "../native-keyspace.js"
import {
  ensureCluster,
  createdbArgs,
  databaseEncoding,
  nonUtf8DatabaseWarning,
  pgBuild,
  type PgBuild,
  start as pgStart,
  stop as pgStop,
  waitReady as pgWaitReady,
  isPortInUse,
} from "../postgres-ctl.js"
import {
  isPasswordRejected,
  pgClientEnv,
  requirePasswordAuth,
  requireSuperuserPassword,
  superuserPasswordMissingMessage,
} from "../native-pg-auth.js"
function portCheckCommand(port: number): string {
  return process.platform === "win32"
    ? `netstat -ano | findstr :${port}`
    : `lsof -i :${port}`
}

/** The ports native dev binds, each with what usually holds it and how to move it. */
interface NativeDevPorts {
  postgres: number
  server: number
  postgrest: number
  realtime: number
  /** Where the server starts Deno, checked only for a project with functions: nothing binds it otherwise. */
  deno?: number
  /** Where the storage service listens, checked only when native dev runs it. */
  storage?: number
}

const NATIVE_SERVICES = ["postgres", "server", "postgrest", "realtime", "deno", "storage"] as const satisfies readonly (keyof NativeDevPorts)[]

export const NATIVE_PORT_HINTS: Record<keyof NativeDevPorts, { holder: string; move: string }> = {
  postgres: {
    holder: "Another Postgres instance may be running.",
    move: `Move this project's database port with ${DEV_DB_PORT_ENV} in .env, or database.port in supatype.config.ts.`,
  },
  server: {
    holder: "Another supatype-server may be running.",
    move: "Move this project's API server port with server.port in supatype.config.ts, or `supatype dev --port`.",
  },
  postgrest: {
    holder: "Another service may be running.",
    move: "Move this project's PostgREST port with server.postgrestPort in supatype.config.ts.",
  },
  realtime: {
    holder: "Another realtime service, or any app on this port, may be running.",
    move: `Move this project's realtime port with ${REALTIME_PORT_ENV} in .env, or server.realtimePort in supatype.config.ts.`,
  },
  deno: {
    holder: "Another Deno process, or any app on this port, may be running.",
    move: `Move this project's functions port with ${DENO_PORT_ENV} in .env.`,
  },
  storage: {
    holder: "Another storage service, or any app on this port, may be running.",
    move: `Move this project's storage port with ${STORAGE_PORT_ENV} in .env.`,
  },
}

/** Stop before anything starts when a port native dev binds is taken. Exported for tests. */
export async function assertNativeDevPortsFree(ports: NativeDevPorts): Promise<void> {
  for (const service of NATIVE_SERVICES) {
    const port = ports[service]
    if (port === undefined || !(await isPortInUse(port))) continue
    const { holder, move } = NATIVE_PORT_HINTS[service]
    fatalError(`Port ${port} is already in use.`, [holder, `Check: ${portCheckCommand(port)}`, move], {
      brand: { intro: "Local development" },
    })
  }
}

/**
 * `dev --overwrite-drift` only where the engine that will push can honour it: the compose
 * schema-engine (or `overrides.engine`) for docker, the engine binary otherwise.
 */
async function requireDevEngineSupports(
  cwd: string,
  config: import("../project-config.js").SupatypeProjectConfig,
  docker: boolean,
): Promise<void> {
  const need = [OVERWRITE_DRIFT_NEED]
  try {
    if (docker) {
      const { requireDockerFeatures } = await import("../dev-compose.js")
      await requireDockerFeatures(cwd, config, need)
    } else {
      assertSupported(binaryCapabilities(await ensureBinary("engine", config)), need)
    }
  } catch (err: unknown) {
    if (err instanceof OwnershipUnsupportedError || err instanceof EngineProbeFailed) fatalError(err.message)
    throw err
  }
}

export function registerDev(program: Command): void {
  program
    .command("dev")
    .description("Start local Postgres, apply schema, and run supatype-server")
    .option("--no-watch", "Start services but do not watch for schema changes, or (Docker) for function changes")
    .option("--stream", "Print interleaved logs instead of the interactive TUI")
    .option("--port <port>", "Port for supatype-server (overrides config)", String)
    .option("--reset-db", "Remove the local Postgres data volume before starting (asks first; storage is kept)")
    .option("--yes", "Skip the --reset-db confirmation")
    .option(
      "--overwrite-drift",
      "Every push of this session puts back policies, grants, labels and RLS changed outside Supatype",
    )
    // Ctrl+C during the start reaches its children too: it ends with one line, not their failure.
    .action(stopQuietlyDuringStart(async (opts: {
      watch: boolean
      stream?: boolean
      port?: string
      resetDb?: boolean
      yes?: boolean
      overwriteDrift?: boolean
    }) => {
      const cwd = process.cwd()

      // ── 1. Load project config (before TUI, fatal errors must hit real stderr) ──
      const config = loadConfig(cwd)
      const provider = resolveRuntimeProvider(config)

      // The native provider keeps Postgres in a data directory, not a compose volume, and has
      // nothing for this flag to remove. Saying so beats silently starting on the old data.
      if (opts.resetDb === true && provider !== "docker") {
        fatalError("--reset-db applies to the Docker provider only.", [
          "This project runs Postgres natively, so there is no compose volume to remove.",
        ])
      }

      if (provider === "docker") {
        const probe = probeDockerDaemon()
        if (!probe.ok) {
          reportDockerUnavailable(probe, { brand: { intro: "Local development" } })
          process.exit(1)
        }
      }

      const projectName = config.project.name
      const serverPort = opts.port ?? String(nativeServerPort(config))
      const postgrestPort = String(config.server.postgrestPort ?? 3001)
      const pgPort = nativeDbPort(config, cwd)
      const realtimePort = String(nativeRealtimePort(config, cwd))
      const denoPort = nativeDenoPort(cwd)
      const storagePort = nativeStoragePort(cwd)
      // Edge functions and model hooks run only when their directory exists, so Deno's port matters
      // only then.
      const functionsDir = functionsPathCandidatesFromProject(config, cwd).find((dir) => existsSync(dir))
      const hooksDir = hooksPathFromProject(config, cwd)
      const runsWorker = functionsDir !== undefined || existsSync(hooksDir)

      if (provider !== "docker") {
        await assertNativeDevPortsFree({
          postgres: pgPort,
          server: Number(serverPort),
          postgrest: Number(postgrestPort),
          realtime: Number(realtimePort),
          ...(runsWorker && { deno: denoPort }),
          ...(keepsObjectsLocally(config) && { storage: storagePort }),
        })
        // Before anything is generated: a missing password would otherwise be replaced in .env
        // with a new one the existing cluster has never heard of.
        requireSuperuserPassword(cwd, nativeDataDir(config))
      }

      // Before the session takes the terminal, so a refusal reaches it.
      const overwriteDrift = opts.overwriteDrift === true
      if (overwriteDrift) await requireDevEngineSupports(cwd, config, provider === "docker")
      // The compose file puts the database passwords into URLs as `${VAR}`, unencoded. Checked
      // here, before the session takes the terminal, and only here: the watcher rewrites the compose
      // file mid-session, where a refusal would end the session.
      if (provider === "docker") requireUrlSafeComposePasswords(cwd, config)

      beginDevSession(resolveDevUiMode(opts.stream === true))
      if (hasMeaningfulOverrides(config)) {
        console.warn("[supatype] Local binary overrides active:")
        for (const line of describeActiveOverrides(config)) {
          console.warn(line)
        }
        console.warn("")
      }

      // Both providers, before anything starts. A project without one gets one in .env here (the
      // shell's when usable, else generated), which every later step signs and validates with.
      // Compose is run without a shell JWT_SECRET that differs from it (self-host-compose.ts), so
      // that one is only warned about, and only when .env already had a secret: one written just
      // now was the shell's, or devJwtSecret has already said why it was not.
      const hadJwtSecret = hasEnvValue(cwd, "JWT_SECRET")
      const jwtSecret = devJwtSecret(cwd)
      requireUsableJwtSecret(jwtSecret)
      const ignored = hadJwtSecret ? ignoredJwtSecretWarning(jwtSecret, givenJwtSecret()) : undefined
      if (ignored !== undefined) console.warn(`[supatype] ${ignored}`)

      if (provider === "docker") {
        const { runDevCompose } = await import("../dev-compose.js")
        await runDevCompose(cwd, config, {
          watch: opts.watch !== false,
          resetDb: opts.resetDb === true,
          yes: opts.yes === true,
          overwriteDrift,
        })
        return
      }

      // ── 2. Resolve engine + server binaries ──────────────────────────────
      console.log(`[supatype] Resolving component binaries for "${projectName}"...`)
      const [engineBin, serverBin] = await Promise.all([
        ensureBinary("engine", config),
        ensureBinary("server", config),
      ])

      // ── 3. Per-project state directories ─────────────────────────────────
      const stateRoot = nativeStateRoot(config)
      const pidDir = join(stateRoot, "pid")
      const logsDir = join(stateRoot, "logs")
      const tmpDir = join(stateRoot, "tmp")

      for (const d of [pidDir, logsDir, tmpDir]) {
        mkdirSync(d, { recursive: true })
      }

      // ── 5–7. Start Postgres ───────────────────────────────────────────────
      let dbURL: string
      /** What PostgREST connects as, deliberately not `dbURL`, which is a superuser. */
      let postgrestDbURL: string
      // Checked by the cluster (native-pg-auth.ts): .env's, or generated and written there.
      const pgPassword = ensureNativeSuperuserPassword(cwd)
      // Distinct from pgPassword even locally, so the split the other paths enforce is the
      // one developers see. Read from .env when present so it matches a stack the user has
      // already provisioned, generated otherwise.
      const authenticatorPassword = ensureNativeAuthenticatorPassword(cwd)
      // pgBinDir is set on the native path and used to add DLL search path for
      // PostgREST on Windows (PostgREST links against libpq + SSL from MinGW).
      let pgBinDir: string | null = null
      // The port the native Postgres serves RESP on, or null when this archive
      // has no pg_keyspace and the Valkey sidecar is what the cache talks to.
      let keyspacePort: number | null = null

      {
        // native: resolve pg bin dir and manage with pg_ctl
        pgBinDir = await resolvePgBinDir(config)
        const dataDir = nativeDataDir(config)
        mkdirSync(dataDir, { recursive: true })
        // The RESP keyspace, when this archive carries it: one process instead
        // of a Postgres and a Valkey container. The port is chosen rather than
        // fixed because 6379 is the first thing a developer's own Redis or a
        // leftover sidecar takes, and a keyspace that cannot bind its port
        // fails inside the postmaster log where nobody is looking.
        keyspacePort = await nativeKeyspacePort(config, pgBinDir)

        const pgOpts = {
          pgBinDir,
          dataDir,
          port: pgPort,
          logPath: join(logsDir, "postgres.log"),
          database: projectName,
          ...(keyspacePort !== null
            ? { keyspacePort, keyspaceDatabase: projectName }
            : {}),
        }

        // initdb, and createdb on a first start, need the archive's version and ICU support; asked once.
        let build: PgBuild | undefined
        const buildOnce = (): PgBuild => (build ??= pgBuild(pgBinDir))
        ensureCluster(pgOpts, pgPassword, buildOnce)
        console.log("[supatype] Starting Postgres...")
        pgStart(pgOpts)
        pushStartUndoLast(() => pgStop(pgOpts, { quiet: true }))
        await pgWaitReady(pgOpts, 15_000)
        console.log("[supatype] Postgres is ready.")
        // Between start steps: once a Ctrl+C has begun the shutdown, nothing more is started.
        await haltIfStopping()
        if (requirePasswordAuth(pgOpts, pgPassword)) {
          console.log("[supatype] This Postgres trusted every local connection; it now checks passwords.")
        }
        dbURL = localDSN(config, pgPassword, cwd)
        // A port only the shell gives is offered to .env (B1), then a DATABASE_URL the CLI wrote,
        // for Docker perhaps, names this database (N1).
        await reconcileNativeDevDatabaseUrl(cwd, dbURL)
        postgrestDbURL = `postgres://authenticator:${encodeURIComponent(authenticatorPassword)}@127.0.0.1:${pgPort}/${projectName}?sslmode=disable`

        const psqlBin    = join(pgBinDir, process.platform === "win32" ? "psql.exe"    : "psql")
        const pgConnArgs = ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres"]
        const pgEnv = pgClientEnv(pgBinDir, pgPassword)
        ensureProjectDatabase({ binDir: pgBinDir, connArgs: pgConnArgs, env: pgEnv, dataDir, name: projectName, build: buildOnce })

        // Create roles required by PostgREST and grant them to postgres so
        // PostgREST can SET ROLE when processing requests.
        //   anon          – unauthenticated requests (RLS enforced)
        //   authenticated – signed-in user requests  (RLS enforced)
        //   service_role  – developer/admin bypass   (BYPASSRLS)
        //   authenticator – the role PostgREST *connects* as, and nothing else
        //
        // `authenticator` is NOINHERIT and holds no privileges of its own: it can only
        // SET ROLE to the three above. That containment is the point. Connecting as
        // `postgres`: a superuser: meant a request whose JWT named *any* role in the
        // cluster got it, because a superuser may SET ROLE to anything. Verified: as
        // postgres, `SET ROLE supatype_replication_admin` succeeds; as authenticator the
        // same statement is refused. Mirrors the image, which has had this role all along.
        // Created here rather than during the push, because the engine chooses how to enforce field
        // rules from the extensions present *when it diffs*. Creating it later would leave the tier
        // decided against a database that no longer looks like that.
        //
        // Conditional on the library being bundled: an archive downloaded before it was would fail
        // the CREATE, and there is nothing the developer could do about it from here.
        const rolesResult = spawnSync(psqlBin, [...pgConnArgs, "-d", projectName, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
          stdio: "pipe",
          encoding: "utf8",
          input: nativeDevRolesSql(pgBinDir),
          env: { ...pgEnv, [AUTHENTICATOR_PASSWORD_ENV]: authenticatorPassword },
        })
        // Unchecked, a failure here surfaced much later as PostgREST refusing to connect or
        // answering 503, with nothing pointing back at the roles or schemas it needed.
        if (rolesResult.status !== 0) {
          throw new Error(`Failed to set up the API roles and schemas: ${(rolesResult.stderr ?? "").trim()}`)
        }
      }

      const LOCAL_JWT_SECRET = devJwtSecret(cwd)
      const authDbURL = dbURL.includes("?")
        ? `${dbURL}&search_path=auth`
        : `${dbURL}?search_path=auth`

      // ── 8. auth migrations (auth.users before engine studio SQL) ─────────
      console.log("[supatype] Running auth migrations...")
      const migrateEnv = authMigrateEnv(serverPort, dbURL, LOCAL_JWT_SECRET)
      runAuthMigrations(serverBin, migrateEnv)
      await haltIfStopping()

      // ── 9. Engine: apply schema ───────────────────────────────────────────
      const schemaPath = schemaPathFromProject(config, cwd)
      const supatypeDir = join(cwd, ".supatype")
      const manifestPath = join(supatypeDir, "manifest.json")
      const adminConfigPath = join(supatypeDir, "admin-config.json")
      mkdirSync(supatypeDir, { recursive: true })

      const localStoragePath = keepsObjectsLocally(config) ? serverStoreRoot(stateRoot) : undefined
      // Native Postgres builds don't include PostGIS, skip geo fields rather than failing.
      const skipFieldKinds: ReadonlySet<string> = new Set(["geo", "vector"])

      // The first push and every one the schema watch makes.
      const schemaPush: NativeSchemaPush = {
        cwd, engineBin, schemaPath, dbURL, adminConfigPath, storagePath: localStoragePath, skipFieldKinds, config, overwriteDrift,
      }
      await runSchemaPush(schemaPush).catch(reportDevPushFailure)
      await haltIfStopping()

      const { ensureFirstAdminUser } = await import("./admin.js")
      await ensureFirstAdminUser(dbURL, { cwd })

      // ── 10. Spawn supatype-server ─────────────────────────────────────────

      // Edge functions config, from the functions dir found before the port check.
      /** Always set when a functions dir exists so Studio admin API can list functions; Deno runtime is separate. */
      // A hooks-only project names the functions directory it would have: the server starts Deno
      // only when it has one, and lists none from a directory that does not exist.
      const denoFunctionsDir = functionsDir ?? (runsWorker ? preferredFunctionsPathFromProject(config, cwd) : "")
      const workerRoutes = localWorkerRoutesOrExit(functionsDir, hooksDir)
      // The functions worker the image runs, from the CLI's copy, behind an entry naming its routes.
      const workerMain = workerRoutes.length > 0 ? installFunctionsWorker() : ""
      const denoServeScriptAbs = workerMain !== "" ? writeDevFunctionsEntry(cwd, workerRoutes, workerMain) : ""

      let denoBinPath: string | undefined
      if (runsWorker) {
        console.log(`[supatype] Edge functions enabled (${functionsDir ?? hooksDir})`)
        try {
          denoBinPath = await ensureBinary("deno", config)
          const denoVersion = await (await import("../binary-cache.js")).resolveVersionFor("deno", config)
          console.log(`[supatype] Deno runtime: ${denoBinPath} (v${denoVersion})`)
          if (workerRoutes.length > 0) {
            console.log(
              `[supatype] Edge functions worker: ${relative(cwd, denoServeScriptAbs)} ` +
                `(${workerRoutes.length} route(s): ${workerRoutes.join(", ")})`,
            )
          } else {
            console.log("[supatype] Edge functions worker not started (no handler files discovered yet)")
          }
        } catch (err) {
          console.warn(
            `[supatype] ⚠  Found ${functionsDir ?? hooksDir} but could not provision Deno, edge functions will not run.\n` +
              `  ${errorMessage(err)}\n` +
              "  (Functions still appear in Studio; invocations need Deno.)",
          )
        }
      }

      // The server passes its environment, the key included, on to Deno, but the functions worker
      // reads the key from a file: a --watch reload evaluates it again in an environment an
      // earlier evaluation already took the key out of.
      const { anonKey, serviceRoleKey } = nativeDevApiKeys(cwd)
      const realtimeUrl = `http://127.0.0.1:${realtimePort}`

      writeAppViteEnv(cwd, config, `http://localhost:${serverPort}`, anonKey)

      // After the push, failed or not: init's manifest names the compose stack's services.
      recordNativeRoutes(manifestPath, denoBinPath !== undefined)

      // Valkey, or the keyspace Postgres serves, alongside realtime and storage: none needs another.
      const valkeyStart = nativeValkey(keyspacePort, projectName)
      const realtimeProc = await startNativeRealtime({
        config, cwd, manifestPath, pidDir, url: realtimeUrl, port: realtimePort,
        databaseUrl: dbURL, jwtSecret: LOCAL_JWT_SECRET,
      })
      const nativeStorage = keepsObjectsLocally(config)
        ? await startNativeStorage({
          config, cwd, manifestPath, pidDir, stateRoot, port: storagePort, databaseUrl: dbURL, jwtSecret: LOCAL_JWT_SECRET,
        })
        : null
      // Later pushes create the buckets a schema declares in the service as well as in buckets.json.
      if (nativeStorage !== null) schemaPush.storageApi = { url: nativeStorage.url, serviceRoleKey }
      const valkeySidecar = await valkeyStart

      // `.env` and `.env.local`, read once for everything the server's environment takes from them.
      const dotEnv = readDotEnvFiles(cwd)
      // What an env("NAME") in auth.providers resolves against: the shell over .env, as for the config.
      const providerEnvironment = { ...dotEnv, ...process.env }
      warnMissingAuthProviderSecrets(config, providerEnvironment)
      const serverEnv: Record<string, string> = {
        ...nativeServerCoreEnv({
          mode: config.server.mode ?? "dev",
          valkeyAddr: valkeySidecar.addr,
          projectRef: projectName,
          manifestPath,
          adminConfigPath,
          postgrestPort,
          pgBinDir,
          databaseUrl: dbURL,
        }),
        SUPATYPE_DENO_FUNCTIONS_DIR: denoFunctionsDir,
        ...(denoBinPath !== undefined ? { SUPATYPE_DENO_PATH: denoBinPath } : {}),
        ...(denoServeScriptAbs !== ""
          ? {
            SUPATYPE_DENO_SERVE_SCRIPT: denoServeScriptAbs,
            // The server passes its environment on to Deno: the worker's, as compose gives the image,
            // functions.serviceRole included, so a function relying on the key unlisted fails here first.
            ...functionsWorkerEnv({ cwd, config, functionsDir: denoFunctionsDir, keyPath: devServiceRoleKeyPath(cwd) }),
            // The server reaches the worker on 127.0.0.1; nothing else on the network should.
            SUPATYPE_FUNCTIONS_HOST: "127.0.0.1",
          }
          : {}),
        SUPATYPE_URL: `http://localhost:${serverPort}`,
        // Natively the server is the gateway, so the address functions call is the one a browser
        // opens. The server passes its environment on to the Deno child that runs them.
        SUPATYPE_PUBLIC_URL: `http://localhost:${serverPort}`,
        SUPATYPE_REALTIME_URL: realtimeUrl,
        SUPATYPE_ANON_KEY: anonKey,
        SUPATYPE_SERVICE_ROLE_KEY: serviceRoleKey,
        PORT: serverPort,
        SUPATYPE_APP_MODE: config.app.mode ?? "none",
        ...(config.app.mode === "static" && config.app.static_dir?.trim()
          ? { SUPATYPE_APP_STATIC_DIR: resolve(cwd, config.app.static_dir.trim()) }
          : {}),
        ...(config.app.mode === "proxy" && config.app.upstream?.trim()
          ? { SUPATYPE_APP_UPSTREAM: config.app.upstream.trim() }
          : {}),
        ...(config.app.vite_dev_url !== undefined && config.app.vite_dev_url.trim() !== ""
          ? { SUPATYPE_VITE_DEV_URL: config.app.vite_dev_url.trim() }
          : {}),
        // Auth service required fields (sensible local-dev defaults)
        SUPATYPE_DB_DATABASE_URL: authDbURL,
        DATABASE_URL: authDbURL,
        SUPATYPE_SQL_DATABASE_URL: dbURL,
        PGSSLMODE: "disable",
        SUPATYPE_DB_NAMESPACE: "auth",
        SUPATYPE_DB_DRIVER: "postgres",
        SUPATYPE_JWT_SECRET: LOCAL_JWT_SECRET,
        SUPATYPE_JWT_EXP: "3600",
        SUPATYPE_JWT_AUD: "authenticated",
        SUPATYPE_JWT_ADMIN_ROLES: "supatype_admin,service_role",
        SUPATYPE_API_HOST: "localhost",
        SUPATYPE_SITE_URL: `http://localhost:${serverPort}`,
        // External URL, mailer provider, emailed-link paths and the send-email hook.
        ...nativeAuthMailerEnv(config.email, serverPort),
        SUPATYPE_LOG_LEVEL: "info",
        SUPATYPE_DISABLE_SIGNUP: "false",
        ...serverStorageEnv(nativeStorage, config, stateRoot),
        // .env last, so a SUPATYPE_EXTERNAL_* value there wins over auth.providers in the config.
        ...nativeAuthProviderEnv(config, `http://localhost:${serverPort}`, providerEnvironment),
        ...nativeServerDotEnvLayer({ dotEnv, config, cwd, denoPort }),
      }

      await haltIfStopping()
      const serverProc = new ProcessManager(serverBin, [], {
        label: "server",
        pidDir,
        colour: "\x1b[32m",
        env: serverEnv,
      })
      serverProc.start()
      pushStartUndo(() => serverProc.stop())

      // ── 9b. PostgREST ────────────────────────────────────────────────────
      let postgrestProc: ProcessManager | null = null
      await haltIfStopping()
      const postgrestBin = await resolvePostgrestBin(config.overrides?.postgrest)
      if (postgrestBin) {
        // Windows PostgREST builds are dynamically linked and require libpq/OpenSSL
        // DLLs from a Postgres bin directory, even when the database runs in Docker.
        let postgrestRuntimeBinDir = pgBinDir
        if (process.platform === "win32" && postgrestRuntimeBinDir === null) {
          try {
            postgrestRuntimeBinDir = await resolvePgBinDir(config)
          } catch (error) {
            console.warn(
              `[supatype] ⚠  Could not resolve Postgres runtime DLL directory for PostgREST: ${errorMessage(error)}\n` +
                "  PostgREST may fail to start on Windows until Postgres binaries are available locally.",
            )
          }
        }

        const postgrestEnv: Record<string, string> = {
          PGRST_DB_URI: postgrestDbURL,
          // Derived from schema.pg_schema (or schema.api_schemas), a hardcoded "public" here meant
          // a non-default pg_schema pushed correctly and then answered PGRST106 on every request.
          // Native dev has no masking extension either, so a schema with field rules is served from
          // `api` here too: the case an "is the database external" rule would have got wrong. The
          // same tier picks the extra search path, which is what pg_graphql reflects: `api` under
          // tier 2, `public` otherwise. Parity with self-host, which writes both from one call.
          ...nativePostgrestSchemaEnv(cwd, config, pgBinDir),
          PGRST_DB_ANON_ROLE: "anon",
          PGRST_SERVER_PORT: postgrestPort,
          PGRST_SERVER_HOST: "127.0.0.1",
          PGRST_JWT_SECRET: serverEnv["SUPATYPE_JWT_SECRET"] ?? "",
          PGRST_LOG_LEVEL: "warn",
          // On Windows, PostgREST (MinGW/GHC binary) needs libpq.dll and
          // OpenSSL DLLs. Prepend a Postgres bin dir which bundles these
          // runtime dependencies.
          ...(process.platform === "win32" && postgrestRuntimeBinDir !== null
            ? { PATH: `${postgrestRuntimeBinDir};${process.env["PATH"] ?? ""}` }
            : {}),
        }

        const preflight = spawnSync(
          postgrestBin,
          ["--help"],
          { env: { ...process.env, ...postgrestEnv }, stdio: "pipe", encoding: "utf8" },
        )
        if (preflight.status !== 0) {
          const detail = (preflight.stderr || preflight.stdout || "").trim()
          console.warn(
            `[supatype] ⚠  PostgREST failed preflight (exit ${preflight.status}). ` +
              "Skipping /rest/v1 startup to avoid crash loop.",
          )
          if (detail) {
            console.warn(`[supatype] PostgREST preflight output:\n${detail}`)
          }
        } else {
        postgrestProc = new ProcessManager(postgrestBin, [], {
          label: "postgrest",
          pidDir,
          colour: "\x1b[36m",
          env: postgrestEnv,
        })
        postgrestProc.start()
        pushStartUndo(() => postgrestProc?.stop())
        }
      }

      // ── 9d. Studio (optional) ─────────────────────────────────────────────
      const studioPort = STUDIO_DEV_PORT
      let studioProc: ProcessManager | null = null

      await haltIfStopping()
      const studioOverride = config.overrides?.studio
      if (studioOverride) {
        studioProc = startStudioViteDevServer({
          cwd,
          studioOverride,
          pidDir,
          anonKey,
          proxyTarget: `http://localhost:${serverPort}`,
          viteSupatypeUrl: `http://localhost:${studioPort}`,
        })
        studioProc?.start()
        pushStartUndo(() => studioProc?.stop())
      }

      await haltIfStopping()
      const appProc = startProxyDevApp(cwd, config, pidDir)
      if (appProc) pushStartUndo(() => appProc.stop())

      const links = [
        { label: "API", url: `http://localhost:${serverPort}` },
        { label: "REST", url: `http://localhost:${serverPort}/rest/v1/` },
        { label: "Auth", url: `http://localhost:${serverPort}/auth/v1/` },
        { label: "Storage", url: `http://localhost:${serverPort}/storage/v1/` },
      ]
      if (realtimeProc) {
        links.push({ label: "Realtime", url: `ws://localhost:${serverPort}/realtime/v1/` })
      }
      if (studioProc) {
        links.push({ label: "Studio", url: `http://localhost:${studioPort}` })
      }

      publishDevReady({
        title: "Services running",
        links,
        anonKey,
        serviceRoleKey,
        hints: [`Postgres ${dbURL}`, `JWT secret: #${secretFingerprint(LOCAL_JWT_SECRET)} (in .env)`],
      })

      // ── Shutdown handler ──────────────────────────────────────────────────
      // Everything the start began is undone after it, the services together and then Postgres
      // (pushStartUndo, pushStartUndoLast), so the shutdown has nothing of its own to stop.
      registerDevShutdown(async () => undefined)

      // ── 10. Schema watch ──────────────────────────────────────────────────
      if (opts.watch) {
        const schemaDir = resolve(cwd, schemaPath, "..")
        console.log(`[supatype] Watching ${schemaDir} for changes...`)

        // Deno reloads the worker when a file it imported changes, but not for a function added later.
        const { watchNativeFunctions } = await import("../native-functions-watch.js")
        const functionsWatch = denoServeScriptAbs === ""
          ? null
          : watchNativeFunctions({ cwd, functionsDir, hooksDir, workerMain }, workerRoutes)
        const { watchDevSchema } = await import("../dev-schema-watch.js")
        watchDevSchema({
          dir: schemaDir,
          changedSinceLastPush: async () =>
            JSON.stringify((await buildNativeAst(cwd, schemaPath, config, skipFieldKinds)).ast) !== _lastReadAst,
          push: (why) => {
            console.log(`\n[supatype] ${why}, checking schema...`)
            // A hook the push declares is served once the worker's routes name it.
            runSchemaPush(schemaPush).then(() => functionsWatch?.refresh()).catch(reportDevPushFailure)
          },
        })
      }

      // Block until killed.
      await waitForDevShutdown()
    }))
}

// ---------------------------------------------------------------------------
// Schema push (engine subprocess)
// ---------------------------------------------------------------------------

// Last successfully-pushed AST JSON, used to skip no-op re-fires.
let _lastPushedAst: string | null = null
// AST that failed on its last attempt, always retried even if content is unchanged.
let _lastFailedAst: string | null = null
// The schema the last push read, whether it applied or not: the watch catches up on a save made
// after it, while the rest of dev was starting.
let _lastReadAst: string | null = null

/** Where a native dev push goes, and what it was asked to do beyond the schema. */
interface NativePushTarget {
  dbURL: string
  pgSchema: string
  /** `dev --overwrite-drift`: put back access changed outside Supatype on every push. */
  overwriteDrift: boolean
}

/** The schema a native dev push sends, and how to build it again once a rename is recorded. */
interface NativeSchema {
  ast: ExtractedSchemaAstV2
  rebuild: () => Promise<ExtractedSchemaAstV2>
}

/**
 * One push of a native dev session. Never forced: a change that would drop data, or one that would
 * put back access changed outside Supatype, is asked about in a terminal as `push` asks it and
 * refused anywhere else, and the caller logs the refusal (or the no) while dev keeps watching.
 *
 * The schema is built again only after a rename confirmed at the prompt was recorded in the journal,
 * which the next attempt has to carry. Returns the schema that applied.
 */
async function pushNativeSchema(
  cwd: string,
  schema: NativeSchema,
  target: NativePushTarget,
): Promise<{ ast: ExtractedSchemaAstV2 }> {
  const { ensureEngine, enginePush, engineRequest } = await import("../engine-client.js")
  const { writeSchemaSourcePushArtifacts } = await import("../schema-sources.js")
  const { DEV_DESTRUCTIVE_POLICY, consentDepsFromDiff, pushConsentingToDestructive } = await import(
    "../destructive-consent.js"
  )
  const { devPushConsentingToDrift } = await import("../drift-consent.js")
  await ensureEngine()
  const sources = writeSchemaSourcePushArtifacts(cwd, true)
  let ast = schema.ast
  let stale = false
  const request = async () => {
    if (stale) [ast, stale] = [await schema.rebuild(), false]
    return { ast, database_url: target.dbURL, schema: target.pgSchema }
  }
  const diff = async () => engineRequest("/diff", await request(), isDiffResult)
  const deps = rebuildingAfterRename(consentDepsFromDiff(cwd, diff), () => {
    stale = true
  })
  const once = async (overwrite: boolean): Promise<void> => {
    const result = await pushConsentingToDestructive(
      async (force) =>
        enginePush(
          cwd,
          {
            ...(await request()),
            force,
            ...(overwrite && { overwrite_drift: true }),
            ...(sources && {
              schema_sources_gz_base64: sources.payload.dataBase64,
              schema_sources_manifest: sources.payload.manifest,
            }),
          },
          isEnginePushResult,
        ),
      DEV_DESTRUCTIVE_POLICY,
      deps,
    )
    reportAppliedPush(result)
  }
  await devPushConsentingToDrift(once, target.overwriteDrift, {
    beforeOverwrite: () => requireEngineFeatures([OVERWRITE_DRIFT_NEED]),
  })
  return { ast }
}

/**
 * `deps` with a rename journal writer that also calls `recorded`, so the attempt after a confirmed
 * rename builds the schema again and carries the journal entry it wrote.
 */
function rebuildingAfterRename(deps: DestructiveConsentDeps, recorded: () => void): DestructiveConsentDeps {
  const journal = deps.renameWriter
  if (journal === undefined) return deps
  return {
    ...deps,
    renameWriter: {
      write: async (candidate) => {
        recorded()
        await journal.write(candidate)
      },
    },
  }
}

/**
 * The AST native dev pushes, built from the schema file with its rename journal: with the
 * publishing config, as `supatype push` sends it (the engine refuses a versioned schema without
 * one), and with each field whose kind needs a missing Postgres extension replaced by JSONB, which
 * `adapted` names.
 */
async function buildNativeAst(
  cwd: string,
  schemaPath: string,
  config: import("../project-config.js").SupatypeProjectConfig | undefined,
  skipFieldKinds: ReadonlySet<string> | undefined,
): Promise<{ ast: ExtractedSchemaAstV2; adapted: string[] }> {
  const { loadSchemaAst } = await import("../config.js")
  const { withPublishing } = await import("../model-versioning.js")
  const loaded = loadSchemaAst(schemaPath, cwd)
  const ast = config ? withPublishing(loaded, config) : loaded
  if (!skipFieldKinds || skipFieldKinds.size === 0) return { ast, adapted: [] }
  const { filtered, adapted } = adaptUnsupportedKinds(ast, skipFieldKinds)
  return { ast: filtered, adapted }
}

/** What one native dev push reads and writes: the same for the first push and every one after. */
export interface NativeSchemaPush {
  cwd: string
  engineBin: string
  schemaPath: string
  dbURL: string
  adminConfigPath?: string | undefined
  storagePath?: string | undefined
  skipFieldKinds?: ReadonlySet<string> | undefined
  config?: SupatypeProjectConfig | undefined
  /** `dev --overwrite-drift`: put back access changed outside Supatype on every push. */
  overwriteDrift?: boolean | undefined
  /** The storage service, once native dev runs it: declared buckets are created there too. */
  storageApi?: StorageApi | undefined
}

/** The storage service's address and the key that may create buckets in it. */
interface StorageApi {
  url: string
  serviceRoleKey: string
}

/** One push of native dev (provider `native`): the schema on disk, then what describes it. Exported for tests. */
export async function runSchemaPush(push: NativeSchemaPush): Promise<void> {
  const { cwd, engineBin, schemaPath, dbURL, adminConfigPath, storagePath, skipFieldKinds, config, storageApi } = push
  const overwriteDrift = push.overwriteDrift ?? false
  const read = await readNativeSchema(cwd, schemaPath, config, skipFieldKinds)
  const astJson = JSON.stringify(read)
  _lastReadAst = astJson
  // Skip only when this exact AST applied and nothing has failed since. Saving a failed schema
  // again retries it, and putting a refused change back pushes the applied schema again, which is
  // what marks the refusal superseded and clears Studio's notice. Said out loud, since a save that
  // pushes nothing otherwise ends on "checking schema..." and looks like a hang.
  if (astJson === _lastPushedAst && _lastFailedAst === null) {
    console.log("[supatype] Schema unchanged since the last push, nothing to apply.")
    return
  }
  const astPath = join(cwd, ".supatype", "schema.ast.json")
  writeFileSync(astPath, astJson)
  console.log("[supatype] Applying schema...")
  const rebuild = async () => (await buildNativeAst(cwd, schemaPath, config, skipFieldKinds)).ast
  const pgSchemaName = config ? pgSchema(config) : "public"
  const ast = await applyNativeSchema(cwd, { ast: read, rebuild }, { dbURL, pgSchema: pgSchemaName, overwriteDrift })
  writeFileSync(astPath, JSON.stringify(ast))
  await writeNativeSchemaArtifacts({ cwd, engineBin, astPath, adminConfigPath, storagePath, storageApi }, ast, config)
}

/** The schema on disk as native dev pushes it, saying which fields were stood in for by JSONB. */
async function readNativeSchema(
  cwd: string,
  schemaPath: string,
  config: import("../project-config.js").SupatypeProjectConfig | undefined,
  skipFieldKinds: ReadonlySet<string> | undefined,
): Promise<ExtractedSchemaAstV2> {
  const built = await buildNativeAst(cwd, schemaPath, config, skipFieldKinds)
  if (built.adapted.length > 0) {
    console.warn(
      `[supatype] ${built.adapted.length} field(s) replaced with JSONB, required extensions not available:\n` +
        built.adapted.map((s: string) => `    ${s}`).join("\n"),
    )
  }
  return built.ast
}

/**
 * Push, remembering the outcome for the next save's skip. Returns what applied, which is the schema
 * with any rename confirmed at the prompt declared on it.
 */
async function applyNativeSchema(
  cwd: string,
  schema: NativeSchema,
  target: NativePushTarget,
): Promise<ExtractedSchemaAstV2> {
  try {
    const { ast } = await pushNativeSchema(cwd, schema, target)
    _lastPushedAst = JSON.stringify(ast)
    _lastFailedAst = null
    _lastReadAst = _lastPushedAst
    return ast
  } catch (err) {
    _lastFailedAst = JSON.stringify(schema.ast)
    throw err
  }
}

/** Where native dev writes what describes the applied schema. */
interface NativeArtifactPaths {
  cwd: string
  engineBin: string
  astPath: string
  adminConfigPath?: string | undefined
  storagePath?: string | undefined
  storageApi?: StorageApi | undefined
}

/**
 * The buckets, Studio's admin config, the types, and the hook maps and handler types, from the AST
 * applied. The rest of the server's route manifest names where each service is, nothing from the
 * schema, and native dev writes it as it starts them (native-realtime.ts, recordNativeRoutes).
 */
async function writeNativeSchemaArtifacts(
  paths: NativeArtifactPaths,
  ast: ExtractedSchemaAstV2,
  config: import("../project-config.js").SupatypeProjectConfig | undefined,
): Promise<void> {
  const { cwd, engineBin, astPath } = paths
  if (paths.storagePath) await provisionDeclaredBuckets(engineBin, cwd, astPath, paths)
  if (paths.adminConfigPath) await writeNativeAdminConfig(paths, paths.adminConfigPath, ast, config)
  if (config) writeNativeAppliedAst(cwd, config, ast)
  await writeNativeTypes(cwd, ast, config)
}

/** The storage buckets the schema declares, as the engine resolves them; none when it cannot say. */
function declaredBuckets(engineBin: string, cwd: string, astPath: string): ParsedStorageBucket[] {
  const parseResult = spawnSync(engineBin, ["parse", "-i", astPath], { cwd, stdio: "pipe", encoding: "utf8" })
  if (parseResult.status !== 0 || !parseResult.stdout) return []
  try {
    const resolvedAst: unknown = JSON.parse(parseResult.stdout)
    return isParsedBuckets(resolvedAst) ? resolvedAst.storageBuckets ?? [] : []
  } catch {
    return []
  }
}

/**
 * Create the storage buckets the schema declares: in buckets.json, which the server's store reads
 * and the storage service imports when it starts, and in the service itself once it runs.
 */
async function provisionDeclaredBuckets(
  engineBin: string,
  cwd: string,
  astPath: string,
  paths: { storagePath?: string | undefined; storageApi?: StorageApi | undefined },
): Promise<void> {
  const buckets = declaredBuckets(engineBin, cwd, astPath)
  if (buckets.length === 0 || paths.storagePath === undefined) return
  await provisionNativeBuckets(buckets, { storagePath: paths.storagePath, storageApi: paths.storageApi })
}

/**
 * `buckets` in buckets.json, and in the storage service while it runs, saying how many new ones
 * are ready: a bucket the service did not take is not, though buckets.json has it. Exported for tests.
 */
export async function provisionNativeBuckets(
  buckets: ParsedStorageBucket[],
  paths: { storagePath: string; storageApi?: StorageApi | undefined },
): Promise<void> {
  const added = provisionStorageBuckets(buckets, paths.storagePath)
  const failed = paths.storageApi
    ? await provisionBuckets(paths.storageApi.url, paths.storageApi.serviceRoleKey, bucketSpecsFromAst({ storageBuckets: buckets }))
    : []
  const ready = added.filter((id) => !failed.includes(id)).length
  if (ready > 0) console.log(`[supatype] Storage: provisioned ${ready} bucket(s).`)
}

/** Studio's admin config, which the engine writes to stdout, with the project's roles merged in. */
async function writeNativeAdminConfig(
  paths: Pick<NativeArtifactPaths, "cwd" | "engineBin" | "astPath">,
  adminConfigPath: string,
  ast: ExtractedSchemaAstV2,
  config: import("../project-config.js").SupatypeProjectConfig | undefined,
): Promise<void> {
  const adminResult = spawnSync(paths.engineBin, ["admin", "-i", paths.astPath], {
    cwd: paths.cwd,
    stdio: "pipe",
    encoding: "utf8",
  })
  if (adminResult.status !== 0 || !adminResult.stdout) return
  const { withAdminRoles } = await import("../studio-admin-roles.js")
  let admin: unknown
  try {
    admin = JSON.parse(adminResult.stdout) as unknown
  } catch {
    admin = adminResult.stdout
  }
  restoreSystemRelationTargets(admin, ast)
  const merged = config ? withAdminRoles(admin, config) : admin
  writeFileSync(adminConfigPath, `${JSON.stringify(merged, null, 2)}\n`)
}

/**
 * The generated types and client, as `push` writes them, at the default paths when `output` is not
 * set. Native dev never wrote them, so a renamed field left the app compiling against the old name.
 * A failure is a warning: the schema is applied and dev keeps watching.
 */
async function writeNativeTypes(
  cwd: string,
  ast: unknown,
  config?: import("../project-config.js").SupatypeProjectConfig,
): Promise<void> {
  const { projectOutputPaths, writeGeneratedTypes } = await import("../type-generation.js")
  try {
    for (const message of await writeGeneratedTypes({ cwd, ast, ...projectOutputPaths(config?.output) })) {
      console.log(`[supatype] ${message}`)
    }
  } catch (err) {
    console.warn(`[supatype] Type generation failed: ${errorMessage(err)}`)
  }
}

/** Writes the declared buckets buckets.json lacks to it, and returns their ids. */
function provisionStorageBuckets(
  declared: ParsedStorageBucket[],
  storagePath: string,
): string[] {
  const bucketsDir = join(storagePath, ".supatype")
  const bucketsFile = join(bucketsDir, "buckets.json")
  mkdirSync(bucketsDir, { recursive: true })

  // Absent until the first bucket, and anything that is not a list of buckets reads as none.
  const stored = readJsonFile(bucketsFile, isArrayOf(isJsonObject)) ?? []
  const existing = stored.map(withPublicFromMode)
  const corrected = existing.filter((row, i) => row["public"] !== stored[i]?.["public"]).length
  const existingIds = new Set(existing.map((b) => b["id"]))
  const added: string[] = []

  for (const bucket of declared) {
    if (existingIds.has(bucket.id)) continue
    existing.push(nativeBucketRow(bucket, new Date().toISOString()))
    mkdirSync(join(storagePath, bucket.id), { recursive: true })
    added.push(bucket.id)
  }

  if (added.length > 0 || corrected > 0) writeFileSync(bucketsFile, JSON.stringify(existing, null, 2))
  return added
}

// ---------------------------------------------------------------------------
// Resolve Postgres bin dir
// ---------------------------------------------------------------------------

export async function resolvePgBinDir(config: Awaited<ReturnType<typeof loadConfig>>): Promise<string> {
  const override = config.overrides?.postgres_dir
  if (override) {
    // Normalize Git Bash (/c/Users/...) paths to Win32 form (C:\Users\...) on Windows.
    const normalised = normalisePlatformPath(override)
    const resolved = resolve(process.cwd(), normalised)
    const binDir = join(resolved, "bin")
    if (!existsSync(binDir)) {
      throw new Error(`[overrides] postgres_dir does not contain a bin/ directory: ${resolved}`)
    }
    console.warn(`\u26a0  Using local Postgres build: ${resolved}`)
    return binDir
  }

  // Locate cached Postgres archive.
  const { cachePath, currentPlatform, resolveVersionFor } = await import("../binary-cache.js")
  const platform = currentPlatform()
  const version = await resolveVersionFor("postgres", config)

  const pgCacheDir = cachePath("postgres", version)
  const extractedDir = join(pgCacheDir, `pg-${version}`)

  const pgCtlName = platform.os === "windows" ? "pg_ctl.exe" : "pg_ctl"
  if (!existsSync(join(extractedDir, "bin", pgCtlName))) {
    // Try to extract the cached archive.
    await extractPostgresArchive(pgCacheDir, version, platform, extractedDir)
  }

  return join(extractedDir, "bin")
}

async function extractPostgresArchive(
  pgCacheDir: string,
  version: string,
  platform: { os: string; arch: string },
  extractDir: string,
): Promise<void> {
  const ext = platform.os === "windows" ? ".zip" : ".tar.gz"
  const archiveName = `supatype-pg-${postgresArchiveTag(version)}-${platform.os}-${platform.arch}${ext}`
  const archivePath = join(pgCacheDir, archiveName)

  if (!existsSync(archivePath)) {
    throw new Error(
      `Postgres ${version} archive not found. Run: supatype update`,
    )
  }

  extractArchive(archivePath, extractDir)
}

// ---------------------------------------------------------------------------
// PostgREST resolver: downloads from GitHub releases if not cached
// ---------------------------------------------------------------------------

async function resolvePostgrestBin(overridePath?: string): Promise<string | null> {
  // Honour local override (same pattern as engine/server).
  if (overridePath) {
    let p = resolve(process.cwd(), normalisePlatformPath(overridePath))
    if (process.platform === "win32" && !p.endsWith(".exe") && !existsSync(p)) {
      const withExe = p + ".exe"
      if (existsSync(withExe)) p = withExe
    }
    if (existsSync(p)) return p
    console.warn(`[supatype] ⚠  PostgREST override not found at ${p}`)
    return null
  }

  const version = POSTGREST_VERSION
  const platform = currentPlatform()
  const binName = platform.os === "windows" ? "postgrest.exe" : "postgrest"
  const cacheDir = cachePath("postgres", version).replace(/postgres/, "postgrest")
  const binPath = join(cacheDir, binName)
  const archivePath = join(cacheDir, postgrestArchiveName(platform, version))

  if (existsSync(binPath)) {
    // Backfill DLLs for older cached Windows installs where only postgrest.exe
    // was copied from the release archive.
    if (platform.os === "windows" && postgrestRuntimeRepairDue(cacheDir, archivePath)) {
      if (repairWindowsPostgrestRuntime(cacheDir, archivePath, binPath)) markPostgrestUnpacked(cacheDir)
      else console.warn("[supatype] ⚠  PostgREST runtime DLL repair failed; REST API may be unavailable.")
    }
    return binPath
  }

  // Download from GitHub releases.
  const url = postgrestArchiveUrl(platform, version)

  console.log(`[supatype] Downloading PostgREST v${version}...`)
  mkdirSync(cacheDir, { recursive: true })

  let resp: Response
  try {
    resp = await fetch(url)
  } catch (e) {
    console.warn(
      `[supatype] ⚠  Could not download PostgREST (${errorMessage(e)}).\n` +
      `  REST API (/rest/v1/) will be unavailable until the download succeeds.\n` +
      `  Re-run 'supatype dev' once network access to github.com:443 is restored.`,
    )
    return null
  }
  if (!resp.ok) {
    console.warn(`[supatype] ⚠  Could not download PostgREST: HTTP ${resp.status}. REST API will be unavailable.`)
    return null
  }

  const buf = Buffer.from(await resp.arrayBuffer())
  writeFileSync(archivePath, buf)

  // Extract. The Windows zip may nest postgrest.exe inside a subdirectory, so
  // after Expand-Archive we copy postgrest.exe and sibling DLLs to cacheDir.
  if (platform.os === "windows") {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${cacheDir}' -Force; ` +
        `$exe = Get-ChildItem -Path '${cacheDir}' -Recurse -Filter 'postgrest.exe' | Select-Object -First 1; ` +
        `if ($exe) { ` +
        `  Copy-Item -Path $exe.FullName -Destination '${binPath}' -Force; ` +
        `  Get-ChildItem -Path $exe.Directory.FullName -Filter '*.dll' | ` +
        `    ForEach-Object { Copy-Item -Path $_.FullName -Destination '${cacheDir}' -Force }; ` +
        `}`,
      ],
      { stdio: "pipe", encoding: "utf8" },
    )
    if (r.status !== 0) {
      console.warn(`[supatype] ⚠  PostgREST extraction failed: ${r.stderr?.trim() ?? "unknown error"}. REST API will be unavailable.`)
      return null
    }
  } else {
    const r = spawnSync("tar", ["-xJf", archivePath, "-C", cacheDir], { stdio: "pipe" })
    if (r.status !== 0) {
      console.warn("[supatype] ⚠  PostgREST extraction failed. REST API will be unavailable.")
      return null
    }
  }

  if (!existsSync(binPath)) {
    console.warn("[supatype] ⚠  PostgREST binary not found after extraction. REST API will be unavailable.")
    return null
  }

  if (platform.os !== "windows") {
    const { chmod } = await import("node:fs/promises")
    await chmod(binPath, 0o755)
  }

  markPostgrestUnpacked(cacheDir)
  console.log(`[supatype] PostgREST v${version} ready.`)
  return binPath
}

function repairWindowsPostgrestRuntime(cacheDir: string, archivePath: string, binPath: string): boolean {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${cacheDir}' -Force; ` +
      `$exe = Get-ChildItem -Path '${cacheDir}' -Recurse -Filter 'postgrest.exe' | Select-Object -First 1; ` +
      `if ($exe) { ` +
      `  Copy-Item -Path $exe.FullName -Destination '${binPath}' -Force; ` +
      `  Get-ChildItem -Path $exe.Directory.FullName -Filter '*.dll' | ` +
      `    ForEach-Object { Copy-Item -Path $_.FullName -Destination '${cacheDir}' -Force }; ` +
      `}`,
    ],
    { stdio: "pipe", encoding: "utf8" },
  )
  return r.status === 0
}

// ---------------------------------------------------------------------------
// Local-dev JWT generator (no external dep, pure crypto)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AST adaptation: replace extension-dependent fields with JSONB fallbacks
// ---------------------------------------------------------------------------

// Field kinds that require Postgres extensions not available in all builds.
// Maps kind → { extension name, JSONB fallback AST }
const EXTENSION_FIELDS: Record<string, { ext: string; fallback: FieldAstV2 }> = {
  geo:    { ext: "PostGIS",  fallback: { kind: "json", pgType: "JSONB" } },
  vector: { ext: "pgvector", fallback: { kind: "json", pgType: "JSONB" } },
}

function adaptUnsupportedKinds(
  ast: ExtractedSchemaAstV2,
  skipKinds: ReadonlySet<string>,
): { filtered: ExtractedSchemaAstV2; adapted: string[] } {
  const adapted: string[] = []
  const models = ast.models.map((model) => ({ ...model, fields: adaptFields(model, skipKinds, adapted) }))
  return { filtered: { ...ast, models }, adapted }
}

/** `model`'s fields, each of a kind in `skipKinds` replaced by its JSONB fallback and named in `adapted`. */
function adaptFields(
  model: ModelAstV2,
  skipKinds: ReadonlySet<string>,
  adapted: string[],
): Record<string, FieldAstV2> {
  const fields: Record<string, FieldAstV2> = {}
  for (const [name, field] of Object.entries(model.fields)) {
    const info = skipKinds.has(field.kind) ? EXTENSION_FIELDS[field.kind] : undefined
    if (info) {
      fields[name] = { ...info.fallback, required: field["required"] ?? false }
      adapted.push(`${model.name}.${name} (${info.ext} → JSONB)`)
    } else {
      fields[name] = field
    }
  }
  return fields
}

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

/** Minimal auth env for `migrate` (matches required fields in serverEnv below). */
function authMigrateEnv(
  serverPort: string,
  sqlDbURL: string,
  jwtSecret: string,
): Record<string, string> {
  const base = `http://localhost:${serverPort}`
  return {
    // envconfig: the service prefix + DB.DATABASE_URL → SUPATYPE_DB_DATABASE_URL
    SUPATYPE_DB_DATABASE_URL: sqlDbURL,
    DATABASE_URL: sqlDbURL,
    SUPATYPE_DB_DRIVER: "postgres",
    SUPATYPE_DB_NAMESPACE: "auth",
    PGSSLMODE: "disable",
    SUPATYPE_JWT_SECRET: jwtSecret,
    SUPATYPE_API_EXTERNAL_URL: `${base}/auth/v1`,
    SUPATYPE_API_HOST: "localhost",
    SUPATYPE_SITE_URL: base,
    SUPATYPE_MAILER_AUTOCONFIRM: "true",
  }
}

/** Apply auth DDL (auth.users, etc.) before engine push references auth schema. */
function runAuthMigrations(
  serverBin: string,
  migrateEnv: Record<string, string>,
): void {
  const result = spawnSync(serverBin, ["migrate"], {
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      ...migrateEnv,
    },
  })
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim()
    throw new Error(
      `auth migrations failed (exit ${result.status ?? "unknown"})` +
        (detail ? `:\n${detail}` : ""),
    )
  }
}

/**
 * The keyspace native Postgres serves, when it answers RESP, else Valkey: one already running, or
 * the sidecar container.
 */
async function nativeValkey(keyspacePort: number | null, projectName: string): Promise<ValkeySidecarResult> {
  const keyspace = await nativeKeyspaceAddrFor(keyspacePort)
  if (keyspace === null) return ensureValkeySidecar(projectName)
  console.log(`[supatype] Keyspace served by Postgres (${keyspace}).`)
  return externalValkey(keyspace)
}

/** Where native dev's project database lives, and what creating it needs. */
interface ProjectDatabase {
  binDir: string
  connArgs: string[]
  env: NodeJS.ProcessEnv
  dataDir: string
  name: string
  build: () => PgBuild
}

/**
 * The project database: left as it is when psql can report its encoding (with a warning when an
 * older CLI made it in another encoding than UTF8), else created, UTF8 as the cluster. One psql
 * call on every start after the first, where it took createdb, a psql and two version probes.
 */
function ensureProjectDatabase(db: ProjectDatabase): void {
  const psqlBin = join(db.binDir, process.platform === "win32" ? "psql.exe" : "psql")
  const encoding = databaseEncoding(psqlBin, [...db.connArgs, "-d", db.name], db.env)
  if (encoding !== null) {
    const warning = nonUtf8DatabaseWarning(encoding, db.name, db.dataDir)
    if (warning !== null) console.warn(warning)
    return
  }
  const createdbBin = join(db.binDir, process.platform === "win32" ? "createdb.exe" : "createdb")
  const created = spawnSync(createdbBin, createdbArgs(db.connArgs, db.name, db.build()), { stdio: "pipe", encoding: "utf8", env: db.env })
  if (created.status === 0) {
    console.log(`[supatype] Created database "${db.name}".`)
    return
  }
  const stderr = created.stderr ?? ""
  // A POSTGRES_PASSWORD changed by hand reaches here; a deleted one was stopped earlier.
  if (isPasswordRejected(stderr)) {
    const { title, hints } = superuserPasswordMissingMessage(db.dataDir)
    throw new Error([title, ...hints].join("\n  "))
  }
  if (!stderr.includes("already exists")) throw new Error(`Failed to create database "${db.name}": ${stderr}`)
}

/**
 * What push and Docker dev write from an applied AST (applied-ast-artifacts.ts), for native dev,
 * which has no row-cache container. The manifest is made first when there is none: the hook maps
 * only go into one that exists, and the first push runs before native dev records its functions,
 * which sets `functions_enabled` before the server reads it.
 */
function writeNativeAppliedAst(cwd: string, config: SupatypeProjectConfig, ast: unknown): void {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  if (!existsSync(manifestPath)) patchRouteManifest(manifestPath, {})
  for (const line of writeAppliedAstArtifacts(cwd, config, ast, { rowCacheEnv: false }).lines) console.log(`[supatype] ${line}`)
}
