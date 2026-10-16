/**
 * supatype dev: start local Postgres, apply schema, run supatype-server.
 *
 * Runtime provider (top-level `provider` or legacy `database.provider`):
 *   docker: full self-host Compose stack (Kong :18473); see dev-compose.ts (default)
 *   native: host Postgres + host server + host engine
 *
 * Edge functions (when a functions/ dir exists): Deno is resolved from the CDN cache
 * (auto-download on miss). Self-host/cloud Docker stacks use supatype-server in-container;
 * Deno is not provisioned by the CLI on those paths.
 */

import { printPushWarnings, type EnginePushResult } from "../engine-push-output.js"
import type { DiffResult } from "../engine-client.js"
import type { DestructiveConsentDeps } from "../destructive-consent.js"
import { reportDevPushFailure } from "../push-refusal.js"
import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { loadConfig } from "../config.js"
import type { ExtractedSchemaAstV2 } from "../schema-ast-v2.js"
import {
  pgSchema,
  functionsPathCandidatesFromProject,
  localDSN,
  nativeDataDir,
  nativeDbPort,
  nativeRealtimePort,
  nativeStateRoot,
  REALTIME_PORT_ENV,
  resolveRuntimeProvider,
  schemaPathFromProject,
  type SupatypeProjectConfig,
} from "../project-config.js"
import { DEV_DB_PORT_ENV } from "../db-port.js"
import { discoverFunctionsOrExit, writeDevFunctionsRouter } from "../functions-router-gen.js"
import { signJwt } from "../jwt.js"
import { requireUsableJwtSecret } from "../jwt-secret-length.js"
import {
  ensureNativeAuthenticatorPassword,
  devJwtSecret,
  ensureNativeSuperuserPassword,
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
import { POSTGREST_VERSION, postgrestArchiveName, postgrestArchiveUrl } from "../postgrest-release.js"
import { STUDIO_DEV_PORT, startStudioViteDevServer } from "../studio-dev-server.js"
import { restoreSystemRelationTargets } from "../restore-system-relation-targets.js"
import { localStorageEnv } from "../local-storage.js"
import { beginDevSession, endDevSession, resolveDevUiMode, startDevSession } from "../dev-session.js"
import { publishDevReady } from "../dev-ready-panel.js"
import { probeDockerDaemon, reportDockerUnavailable } from "../docker-runtime.js"
import { fatalError } from "../ui/fatal.js"
import { registerDevShutdown, waitForDevShutdown } from "../dev-shutdown.js"
import { startNativeRealtime } from "../native-realtime.js"
import { writeAppViteEnv } from "../app-vite-env.js"
import { nativeAuthProviderEnv, warnMissingAuthProviderSecrets } from "../auth-providers.js"
import { nativeMailerAutoconfirmEnv } from "../mailer-autoconfirm.js"
import { AUTHENTICATOR_PASSWORD_ENV } from "../native-roles-sql.js"
import { nativeDevRolesSql, nativePostgrestSchemaEnv, nativeServerCoreEnv } from "../native-dev-env.js"
import { ensureValkeySidecar, stopValkeySidecar } from "../valkey-sidecar.js"
import { nativeKeyspaceAddr as nativeKeyspaceAddrFor, nativeKeyspacePort } from "../native-keyspace.js"
import {
  initdb,
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
/** Map `email.smtp` from supatype.config.ts into SUPATYPE_SMTP_* for the embedded auth service. */
function authSMTPFromEmailConfig(email: SupatypeProjectConfig["email"] | undefined): Record<string, string> {
  const s = email?.smtp
  if (!s) return {}
  const out: Record<string, string> = {}
  const host = s.host?.trim()
  if (host) out.SUPATYPE_SMTP_HOST = host
  if (s.port !== undefined) out.SUPATYPE_SMTP_PORT = String(s.port)
  const user = s.user?.trim()
  if (user) out.SUPATYPE_SMTP_USER = user
  if (s.pass !== undefined && s.pass !== "") out.SUPATYPE_SMTP_PASS = s.pass
  const admin = s.admin_email?.trim()
  if (admin) out.SUPATYPE_SMTP_ADMIN_EMAIL = admin
  const sender = s.sender_name?.trim()
  if (sender) out.SUPATYPE_SMTP_SENDER_NAME = sender
  return out
}

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
}

const NATIVE_PORT_HINTS: Record<keyof NativeDevPorts, { holder: string; move: string }> = {
  postgres: {
    holder: "Another Postgres instance may be running.",
    move: `Move this project's with ${DEV_DB_PORT_ENV} in .env, or database.port in supatype.config.ts.`,
  },
  server: {
    holder: "Another supatype-server may be running.",
    move: "Move this project's with server.port in supatype.config.ts, or `supatype dev --port`.",
  },
  postgrest: {
    holder: "Another service may be running.",
    move: "Move this project's with server.postgrestPort in supatype.config.ts.",
  },
  realtime: {
    holder: "Another realtime service, or any app on this port, may be running.",
    move: `Move this project's with ${REALTIME_PORT_ENV} in .env, or server.realtimePort in supatype.config.ts.`,
  },
}

async function assertNativeDevPortsFree(ports: NativeDevPorts): Promise<void> {
  for (const [service, port] of Object.entries(ports) as [keyof NativeDevPorts, number][]) {
    if (!(await isPortInUse(port))) continue
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
    .option("--no-watch", "Start services but do not watch for schema changes")
    .option("--stream", "Print interleaved logs instead of the interactive TUI")
    .option("--port <port>", "Port for supatype-server (overrides config)", String)
    .option("--reset-db", "Remove the local Postgres data volume before starting (asks first; storage is kept)")
    .option("--yes", "Skip the --reset-db confirmation")
    .option(
      "--overwrite-drift",
      "Every push of this session puts back policies, grants, labels and RLS changed outside Supatype",
    )
    .action(async (opts: {
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
      const serverPort = opts.port ?? String(config.server.port ?? 54321)
      const postgrestPort = String(config.server.postgrestPort ?? 3001)
      const pgPort = nativeDbPort(config, cwd)
      const realtimePort = String(nativeRealtimePort(config, cwd))

      if (provider !== "docker") {
        await assertNativeDevPortsFree({
          postgres: pgPort,
          server: Number(serverPort),
          postgrest: Number(postgrestPort),
          realtime: Number(realtimePort),
        })
        // Before anything is generated: a missing password would otherwise be replaced in .env
        // with a new one the existing cluster has never heard of.
        requireSuperuserPassword(cwd, nativeDataDir(config))
      }

      // Before the session takes the terminal, so a refusal reaches it.
      const overwriteDrift = opts.overwriteDrift === true
      if (overwriteDrift) await requireDevEngineSupports(cwd, config, provider === "docker")

      beginDevSession(resolveDevUiMode(opts.stream === true))
      if (hasMeaningfulOverrides(config)) {
        console.warn("[supatype] Local binary overrides active:")
        for (const line of describeActiveOverrides(config)) {
          console.warn(line)
        }
        console.warn("")
      }

      // Both providers, before anything starts: the secret a docker stack is seeded with when .env
      // has none is the same fallback this reads.
      requireUsableJwtSecret(devJwtSecret(cwd))

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
      let stopPostgres: () => void | Promise<void>
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
          ...(keyspacePort !== null
            ? { keyspacePort, keyspaceDatabase: projectName }
            : {}),
        }

        console.log("[supatype] Initialising Postgres data directory...")
        initdb(pgOpts, pgPassword)
        console.log("[supatype] Starting Postgres...")
        pgStart(pgOpts)
        await pgWaitReady(pgOpts, 15_000)
        console.log("[supatype] Postgres is ready.")
        if (requirePasswordAuth(pgOpts, pgPassword)) {
          console.log("[supatype] This Postgres trusted every local connection; it now checks passwords.")
        }
        dbURL = localDSN(config, pgPassword, cwd)
        postgrestDbURL = `postgres://authenticator:${encodeURIComponent(authenticatorPassword)}@127.0.0.1:${pgPort}/${projectName}?sslmode=disable`
        stopPostgres = () => pgStop(pgOpts)

        // Create project database if it doesn't exist (native only).
        const psqlBin    = join(pgBinDir, process.platform === "win32" ? "psql.exe"    : "psql")
        const createdbBin = join(pgBinDir, process.platform === "win32" ? "createdb.exe" : "createdb")
        const pgConnArgs = ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres"]
        const pgEnv = pgClientEnv(pgBinDir, pgPassword)
        const createDbResult = spawnSync(
          createdbBin,
          [...pgConnArgs, projectName],
          { stdio: "pipe", encoding: "utf8", env: pgEnv },
        )
        if (createDbResult.status !== 0) {
          const stderr = createDbResult.stderr ?? ""
          // A POSTGRES_PASSWORD changed by hand reaches here; a deleted one was stopped earlier.
          if (isPasswordRejected(stderr)) {
            const { title, hints } = superuserPasswordMissingMessage(dataDir)
            throw new Error([title, ...hints].join("\n  "))
          }
          if (!stderr.includes("already exists")) {
            throw new Error(`Failed to create database "${projectName}": ${stderr}`)
          }
        } else {
          console.log(`[supatype] Created database "${projectName}".`)
        }

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

      // ── 9. Engine: apply schema ───────────────────────────────────────────
      const schemaPath = schemaPathFromProject(config, cwd)
      const supatypeDir = join(cwd, ".supatype")
      const manifestPath = join(supatypeDir, "manifest.json")
      const adminConfigPath = join(supatypeDir, "admin-config.json")
      mkdirSync(supatypeDir, { recursive: true })

      const localStoragePath = config.storage?.provider !== "s3" ? join(stateRoot, "storage") : undefined
      // Native Postgres builds don't include PostGIS, skip geo fields rather than failing.
      const skipFieldKinds: ReadonlySet<string> = new Set(["geo", "vector"])

      await runSchemaPush(cwd, engineBin, schemaPath, dbURL, manifestPath, adminConfigPath, localStoragePath, skipFieldKinds, config, overwriteDrift).catch(
        reportDevPushFailure,
      )

      const { ensureFirstAdminUser } = await import("./admin.js")
      await ensureFirstAdminUser(dbURL, { cwd })

      // ── 10. Spawn supatype-server ─────────────────────────────────────────

      // Resolve edge functions config: only enable Deno if a functions dir exists.
      const functionsDir = functionsPathCandidatesFromProject(config, cwd).find(dir => existsSync(dir))
      const hasFunctionsDir = functionsDir !== undefined
      /** Always set when a functions dir exists so Studio admin API can list functions; Deno runtime is separate. */
      const denoFunctionsDir = hasFunctionsDir ? functionsDir : ""
      const functionRoutes = hasFunctionsDir && functionsDir !== undefined
        ? discoverFunctionsOrExit(functionsDir)
        : []
      const denoServeScriptAbs = hasFunctionsDir && functionsDir !== undefined
        ? (writeDevFunctionsRouter(cwd, functionsDir, functionRoutes) ?? "")
        : ""

      let denoBinPath: string | undefined
      if (hasFunctionsDir) {
        console.log(`[supatype] Edge functions enabled (${functionsDir})`)
        try {
          denoBinPath = await ensureBinary("deno", config)
          const denoVersion = await (await import("../binary-cache.js")).resolveVersionFor("deno", config)
          console.log(`[supatype] Deno runtime: ${denoBinPath} (v${denoVersion})`)
          if (functionRoutes.length > 0) {
            console.log(
              `[supatype] Edge functions router: ${relative(cwd, denoServeScriptAbs) || ".supatype/functions-router.ts"} ` +
                `(${functionRoutes.length} function(s): ${functionRoutes.map(fn => fn.name).join(", ")})`,
            )
          } else {
            console.log("[supatype] Edge functions router not generated (no handler files discovered yet)")
          }
        } catch (err) {
          console.warn(
            `[supatype] ⚠  Found ${functionsDir} but could not provision Deno, edge functions will not run.\n` +
              `  ${(err as Error).message}\n` +
              "  (Functions still appear in Studio; invocations need Deno.)",
          )
        }
      }

      // Matches SUPATYPE_HOOK_SEND_EMAIL_SECRETS symmetric format (dev only). Override via .env.
      const LOCAL_SEND_EMAIL_HOOK_SECRETS =
        "v1,whsec_abcdefghijklmnopqrstuvwxyz01234567"
      const now = Math.floor(Date.now() / 1000)
      const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
      const anonKey        = signJwt({ ...jwtBase, role: "anon" },         LOCAL_JWT_SECRET)
      const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)

      const realtimeUrl = `http://127.0.0.1:${realtimePort}`

      writeAppViteEnv(cwd, config, `http://localhost:${serverPort}`, anonKey)

      const realtimeProc = await startNativeRealtime({
        config, cwd, manifestPath, pidDir, url: realtimeUrl, port: realtimePort,
        databaseUrl: dbURL, jwtSecret: LOCAL_JWT_SECRET,
      })


      const emailProvider = config.email?.provider ?? "console"
      const authMailerProvider =
        emailProvider === "console"
          ? "console"
          : emailProvider === "resend"
            ? "resend"
            : emailProvider === "ses"
              ? "ses"
              : "smtp"

      // Postgres serves RESP itself when the archive had pg_keyspace and the port came up.
      const nativeKeyspaceAddr = await nativeKeyspaceAddrFor(keyspacePort)
      if (nativeKeyspaceAddr) {
        console.log(`[supatype] Keyspace served by Postgres (${nativeKeyspaceAddr}).`)
      }
      const valkeySidecar = nativeKeyspaceAddr
        ? { addr: nativeKeyspaceAddr, containerName: null, started: false }
        : ensureValkeySidecar(projectName)

      // What an env("NAME") in auth.providers resolves against: the shell over .env, as for the config.
      const providerEnvironment = { ...loadDotEnv(cwd), ...process.env }
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
        }),
        SUPATYPE_DENO_FUNCTIONS_DIR: denoFunctionsDir,
        ...(denoFunctionsDir !== "" ? { SUPATYPE_SHARED_ENV_FILE: resolve(denoFunctionsDir, ".env.local") } : {}),
        ...(denoBinPath !== undefined ? { SUPATYPE_DENO_PATH: denoBinPath } : {}),
        ...(denoServeScriptAbs !== ""
          ? { SUPATYPE_DENO_SERVE_SCRIPT: denoServeScriptAbs }
          : {}),
        SUPATYPE_URL: `http://localhost:${serverPort}`,
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
        SUPATYPE_API_EXTERNAL_URL: `http://localhost:${serverPort}/auth/v1`,
        SUPATYPE_API_HOST: "localhost",
        SUPATYPE_SITE_URL: `http://localhost:${serverPort}`,
        SUPATYPE_MAILER_MAILER_PROVIDER: authMailerProvider,
        SUPATYPE_LOG_LEVEL: "info",
        SUPATYPE_DISABLE_SIGNUP: "false",
        ...(config.email?.resend_api_key !== undefined && config.email.resend_api_key !== ""
          ? { RESEND_API_KEY: config.email.resend_api_key }
          : {}),
        ...(authMailerProvider === "resend" &&
        config.email?.resend_from !== undefined &&
        config.email.resend_from.trim() !== ""
          ? { RESEND_FROM: config.email.resend_from.trim() }
          : {}),
        ...(authMailerProvider === "ses" &&
        config.email?.ses_from !== undefined &&
        config.email.ses_from.trim() !== ""
          ? { SES_FROM: config.email.ses_from.trim() }
          : {}),
        ...(authMailerProvider === "smtp" ? authSMTPFromEmailConfig(config.email) : {}),
        ...(config.email?.send_email_hook === true
          ? {
              SUPATYPE_HOOK_SEND_EMAIL_ENABLED: "true",
              SUPATYPE_HOOK_SEND_EMAIL_URI:
                config.email?.send_email_hook_uri !== undefined &&
                config.email.send_email_hook_uri.trim() !== ""
                  ? config.email.send_email_hook_uri.trim()
                  : `http://127.0.0.1:${serverPort}/internal/v0hooks/send-email`,
              SUPATYPE_HOOK_SEND_EMAIL_SECRETS:
                config.email?.send_email_hook_secrets !== undefined &&
                config.email.send_email_hook_secrets.trim() !== ""
                  ? config.email.send_email_hook_secrets.trim()
                  : LOCAL_SEND_EMAIL_HOOK_SECRETS,
            }
          : {}),
        ...(config.storage?.provider !== "s3" ? localStorageEnv(stateRoot) : {}),
        // .env last, so a SUPATYPE_EXTERNAL_* value there wins over auth.providers in the config.
        ...nativeAuthProviderEnv(config, `http://localhost:${serverPort}`, providerEnvironment),
        ...loadDotEnv(cwd),
        // After .env: auth.email.enableConfirmations, unless the developer set their own value.
        ...nativeMailerAutoconfirmEnv(cwd, config),
      }

      const serverProc = new ProcessManager(serverBin, [], {
        label: "server",
        pidDir,
        colour: "\x1b[32m",
        env: serverEnv,
      })
      serverProc.start()

      // ── 9b. PostgREST ────────────────────────────────────────────────────
      let postgrestProc: ProcessManager | null = null
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
              `[supatype] ⚠  Could not resolve Postgres runtime DLL directory for PostgREST: ${(error as Error).message}\n` +
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
        }
      }

      // ── 9d. Studio (optional) ─────────────────────────────────────────────
      const studioPort = STUDIO_DEV_PORT
      let studioProc: ProcessManager | null = null

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
      }

      const appProc = startProxyDevApp(cwd, config, pidDir)

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
      registerDevShutdown(async () => {
        console.log("[supatype] Shutting down...")
        await Promise.all([
          serverProc.stop(),
          realtimeProc?.stop(),
          postgrestProc?.stop(),
          studioProc?.stop(),
          appProc?.stop(),
        ])
        stopValkeySidecar(valkeySidecar.containerName)
        await stopPostgres()
      })

      // ── 10. Schema watch ──────────────────────────────────────────────────
      if (opts.watch) {
        const schemaDir = resolve(cwd, schemaPath, "..")
        console.log(`[supatype] Watching ${schemaDir} for changes...`)

        const { watch } = await import("node:fs")
        // Debounce: Windows fs.watch fires multiple events per save.
        // Wait 300 ms after the last event before pushing.
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        watch(schemaDir, { recursive: true }, (_eventType, filename) => {
          if (!filename?.endsWith(".ts")) return
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            console.log(`\n[supatype] Change detected in ${filename}, checking schema...`)
            runSchemaPush(cwd, engineBin, schemaPath, dbURL, manifestPath, adminConfigPath, localStoragePath, skipFieldKinds, config, overwriteDrift).catch(
              reportDevPushFailure,
            )
          }, 300)
        })
      }

      // Block until killed.
      await waitForDevShutdown()
    })
}

// ---------------------------------------------------------------------------
// Schema push (engine subprocess)
// ---------------------------------------------------------------------------

// Last successfully-pushed AST JSON, used to skip no-op re-fires.
let _lastPushedAst: string | null = null
// AST that failed on its last attempt, always retried even if content is unchanged.
let _lastFailedAst: string | null = null

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
  const sources = writeSchemaSourcePushArtifacts(cwd)
  let ast = schema.ast
  let stale = false
  const request = async () => {
    if (stale) [ast, stale] = [await schema.rebuild(), false]
    return { ast, database_url: target.dbURL, schema: target.pgSchema }
  }
  const diff = async () => engineRequest<DiffResult>("/diff", await request())
  const deps = rebuildingAfterRename(consentDepsFromDiff(cwd, diff), () => {
    stale = true
  })
  const once = async (overwrite: boolean): Promise<void> => {
    const result = await pushConsentingToDestructive(
      async (force) =>
        enginePush<EnginePushResult>(cwd, {
          ...(await request()),
          force,
          ...(overwrite && { overwrite_drift: true }),
          ...(sources && {
            schema_sources_gz_base64: sources.payload.dataBase64,
            schema_sources_manifest: sources.payload.manifest,
          }),
        }),
      DEV_DESTRUCTIVE_POLICY,
      deps,
    )
    printPushWarnings(result)
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

async function runSchemaPush(
  cwd: string,
  engineBin: string,
  schemaPath: string,
  dbURL: string,
  manifestPath: string,
  adminConfigPath?: string,
  storagePath?: string,
  skipFieldKinds?: ReadonlySet<string>,
  config?: import("../project-config.js").SupatypeProjectConfig,
  /** `dev --overwrite-drift`: put back access changed outside Supatype on every push. */
  overwriteDrift = false,
): Promise<void> {
  const built = await buildNativeAst(cwd, schemaPath, config, skipFieldKinds)
  if (built.adapted.length > 0) {
    console.warn(
      `[supatype] ${built.adapted.length} field(s) replaced with JSONB, required extensions not available:\n` +
        built.adapted.map((s: string) => `    ${s}`).join("\n"),
    )
  }
  let ast = built.ast
  const astJson = JSON.stringify(ast)

  // Skip only when the last push of this exact AST succeeded.
  // If it previously failed we always retry so the user can trigger a re-run
  // by simply saving the file again without needing to make a content change.
  if (astJson === _lastPushedAst && astJson !== _lastFailedAst) {
    return
  }

  const astPath = join(cwd, ".supatype", "schema.ast.json")
  writeFileSync(astPath, astJson)

  // Push schema.
  console.log("[supatype] Applying schema...")
  try {
    const rebuild = async () => (await buildNativeAst(cwd, schemaPath, config, skipFieldKinds)).ast
    const pgSchemaName = config ? pgSchema(config) : "public"
    ast = (await pushNativeSchema(cwd, { ast, rebuild }, { dbURL, pgSchema: pgSchemaName, overwriteDrift })).ast
  } catch (err) {
    _lastFailedAst = astJson
    throw err
  }
  // What applied, which is the schema with any rename confirmed at the prompt declared on it.
  _lastPushedAst = JSON.stringify(ast)
  _lastFailedAst = null
  writeFileSync(astPath, _lastPushedAst)

  // Provision storage buckets declared in the schema.
  if (storagePath) {
    const parseResult = spawnSync(engineBin, ["parse", "-i", astPath], { cwd, stdio: "pipe", encoding: "utf8" })
    if (parseResult.status === 0 && parseResult.stdout) {
      try {
        const resolvedAst = JSON.parse(parseResult.stdout) as {
          storageBuckets?: Array<{
            id: string
            public: boolean
            allowedMimeTypes?: string[]
            fileSizeLimit?: number
            accessMode?: string
            s3BucketPolicy?: string | null
          }>
        }
        if (resolvedAst.storageBuckets && resolvedAst.storageBuckets.length > 0) {
          provisionStorageBuckets(resolvedAst.storageBuckets, storagePath)
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // Generate manifest.
  const genResult = spawnSync(
    engineBin,
    ["generate", "-i", astPath, "-o", manifestPath],
    { cwd, stdio: "pipe", encoding: "utf8" },
  )
  if (genResult.status !== 0) {
    console.warn("[supatype] Manifest generation failed, server routing may be stale.")
  }

  // Generate admin config (for Studio). Engine writes to stdout.
  if (adminConfigPath) {
    const adminResult = spawnSync(
      engineBin,
      ["admin", "-i", astPath],
      { cwd, stdio: "pipe", encoding: "utf8" },
    )
    if (adminResult.status === 0 && adminResult.stdout) {
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
  }

  await writeNativeTypes(cwd, ast, config)
  console.log("[supatype] Schema applied.")
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
    console.warn(`[supatype] Type generation failed: ${(err as Error).message}`)
  }
}

function provisionStorageBuckets(
  declared: Array<{
    id: string
    public: boolean
    allowedMimeTypes?: string[]
    fileSizeLimit?: number
    accessMode?: string
    s3BucketPolicy?: string | null
  }>,
  storagePath: string,
): void {
  const bucketsDir = join(storagePath, ".supatype")
  const bucketsFile = join(bucketsDir, "buckets.json")
  mkdirSync(bucketsDir, { recursive: true })

  let existing: Array<Record<string, unknown>> = []
  try {
    existing = JSON.parse(readFileSync(bucketsFile, "utf8")) as Array<Record<string, unknown>>
  } catch { /* file doesn't exist yet */ }

  const existingIds = new Set(existing.map((b) => b["id"] as string))
  let added = 0

  for (const bucket of declared) {
    if (existingIds.has(bucket.id)) continue
    const now = new Date().toISOString()
    existing.push({
      id: bucket.id,
      name: bucket.id,
      public: bucket.public,
      file_size_limit: bucket.fileSizeLimit ?? null,
      allowed_mime_types: bucket.allowedMimeTypes ?? null,
      access_mode:
        bucket.accessMode ?? (bucket.public ? "public" : "private"),
      s3_bucket_policy: bucket.s3BucketPolicy ?? null,
      created_at: now,
      updated_at: now,
    })
    mkdirSync(join(storagePath, bucket.id), { recursive: true })
    added++
  }

  if (added > 0) {
    writeFileSync(bucketsFile, JSON.stringify(existing, null, 2))
    console.log(`[supatype] Storage: provisioned ${added} bucket(s).`)
  }
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

  mkdirSync(extractDir, { recursive: true })

  // On Windows, Git Bash tar is typically first in PATH and chokes on drive-letter
  // paths (C:\...). Use PowerShell's Expand-Archive instead, which handles Windows
  // paths natively. On Linux/macOS, use tar as normal.
  const result = platform.os === "windows"
    ? spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`],
        { stdio: "inherit" },
      )
    : spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "inherit" })

  if (result.status !== 0) {
    throw new Error(`Failed to extract Postgres archive: ${archivePath}`)
  }
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
    if (platform.os === "windows" && !hasLikelyWindowsRuntimeDlls(cacheDir) && existsSync(archivePath)) {
      const repaired = repairWindowsPostgrestRuntime(cacheDir, archivePath, binPath)
      if (!repaired) {
        console.warn("[supatype] ⚠  PostgREST runtime DLL repair failed; REST API may be unavailable.")
      }
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
      `[supatype] ⚠  Could not download PostgREST (${(e as Error).message}).\n` +
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

  console.log(`[supatype] PostgREST v${version} ready.`)
  return binPath
}

function hasLikelyWindowsRuntimeDlls(dir: string): boolean {
  if (process.platform !== "win32") return true
  return (
    existsSync(join(dir, "libpq.dll")) ||
    existsSync(join(dir, "libpq-5.dll")) ||
    existsSync(join(dir, "libssl-3-x64.dll"))
  )
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

interface AstField { kind: string; required?: boolean; [k: string]: unknown }
interface AstModel { name: string; fields?: Record<string, AstField> }
interface AstSchema { models?: AstModel[] }

// Field kinds that require Postgres extensions not available in all builds.
// Maps kind → { extension name, JSONB fallback AST }
const EXTENSION_FIELDS: Record<string, { ext: string; fallback: AstField }> = {
  geo:    { ext: "PostGIS",  fallback: { kind: "json", pgType: "JSONB" } },
  vector: { ext: "pgvector", fallback: { kind: "json", pgType: "JSONB" } },
}

function adaptUnsupportedKinds(
  ast: ExtractedSchemaAstV2,
  skipKinds: ReadonlySet<string>,
): { filtered: ExtractedSchemaAstV2; adapted: string[] } {
  const adapted: string[] = []
  if (!ast || typeof ast !== "object") return { filtered: ast, adapted }
  const schema = ast as AstSchema
  if (!Array.isArray(schema.models)) return { filtered: ast, adapted }

  const models = schema.models.map((model) => {
    const fields: Record<string, AstField> = {}
    for (const [name, field] of Object.entries(model.fields ?? {})) {
      const info = skipKinds.has(field.kind) ? EXTENSION_FIELDS[field.kind] : undefined
      if (info) {
        fields[name] = { ...info.fallback, required: field.required ?? false }
        adapted.push(`${model.name}.${name} (${info.ext} → JSONB)`)
      } else {
        fields[name] = field
      }
    }
    return { ...model, fields }
  })

  return { filtered: { ...schema, models } as ExtractedSchemaAstV2, adapted }
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

function loadDotEnv(cwd: string): Record<string, string> {
  const candidates = [resolve(cwd, ".env"), resolve(cwd, ".env.local")]
  const vars: Record<string, string> = {}
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
  }
  return vars
}
