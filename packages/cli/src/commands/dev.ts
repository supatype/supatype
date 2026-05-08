/**
 * supatype dev — start local Postgres, apply schema, run supatype-server.
 *
 * Supports two database providers (set in supatype.config.ts):
 *   provider = "docker"  — runs supatype/postgres via Docker (default; includes all extensions)
 *   provider = "native"  — manages a native Postgres binary from the supatype cache
 */

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { loadConfig } from "../config.js"
import { functionsPathCandidatesFromProject, schemaPathFromProject } from "../project-config.js"
import { discoverTsFunctionsInDir, writeDevFunctionsRouter } from "../functions-router-gen.js"
import { signJwt } from "../jwt.js"
import { resolveBinary, normalisePlatformPath, cachePath, currentPlatform } from "../binary-cache.js"
import { ProcessManager } from "../process-manager.js"
import { localStorageEnv } from "../local-storage.js"
import { initdb, start as pgStart, stop as pgStop, waitReady as pgWaitReady, isPortInUse } from "../postgres-ctl.js"
import {
  dockerPgStart,
  dockerPgStop,
  dockerPgWaitReady,
  dockerDbUrl,
} from "../docker-postgres.js"

const DEFAULT_DOCKER_IMAGE = "supatype/postgres:17-latest"

/**
 * Resolve Deno robustly on Windows + Unix.
 * - Respects config.overrides.deno when provided
 * - Tries common command variants (`deno`, `deno.cmd`, `deno.exe`)
 * - Falls back to `cmd /c deno --version` on Windows PATH edge-cases
 */
function detectDenoBinary(
  cwd: string,
  overridePath: string | undefined,
): { available: boolean; command?: string; argsPrefix?: string[] } {
  const candidates: Array<{ command: string; argsPrefix: string[]; runtimeCommand?: string }> = []

  if (overridePath && overridePath.trim().length > 0) {
    const raw = overridePath.trim()
    const cmd = isAbsolute(raw) ? raw : resolve(cwd, raw)
    candidates.push({ command: cmd, argsPrefix: [], runtimeCommand: cmd })
  }

  candidates.push(
    { command: "deno", argsPrefix: [], runtimeCommand: "deno" },
    { command: "deno.cmd", argsPrefix: [], runtimeCommand: "deno.cmd" },
    { command: "deno.exe", argsPrefix: [], runtimeCommand: "deno.exe" },
  )

  if (process.platform === "win32") {
    // Probe PATH via cmd, but runtime should still invoke `deno` directly.
    candidates.push({
      command: "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "deno"],
      runtimeCommand: "deno",
    })
  }

  for (const c of candidates) {
    const res = spawnSync(c.command, [...c.argsPrefix, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    if (res.status === 0) {
      return { available: true, command: c.runtimeCommand ?? c.command, argsPrefix: c.argsPrefix }
    }
  }

  return { available: false }
}

export function registerDev(program: Command): void {
  program
    .command("dev")
    .description("Start local Postgres, apply schema, and run supatype-server")
    .option("--no-watch", "Start services but do not watch for schema changes")
    .option("--port <port>", "Port for supatype-server (overrides config)", String)
    .action(async (opts: { watch: boolean; port?: string }) => {
      const cwd = process.cwd()

      // ── 1. Load project config ─────────────────────────────────────────────
      const config = loadConfig(cwd)
      const projectName = config.project.name
      const serverPort = opts.port ?? String(config.server.port ?? 54321)
      const postgrestPort = String(config.server.postgrestPort ?? 3001)
      const provider = config.database.provider ?? "docker"

      // ── 2. Resolve engine + server binaries ──────────────────────────────
      console.log(`[supatype] Resolving component binaries for "${projectName}"...`)
      const [engineBin, serverBin] = await Promise.all([
        resolveBinary("engine", config),
        resolveBinary("server", config),
      ])

      // ── 3. Per-project state directories ─────────────────────────────────
      const stateRoot = join(homedir(), ".supatype", "projects", projectName)
      const pidDir = join(stateRoot, "pid")
      const logsDir = join(stateRoot, "logs")
      const tmpDir = join(stateRoot, "tmp")

      for (const d of [pidDir, logsDir, tmpDir]) {
        mkdirSync(d, { recursive: true })
      }

      // ── 4. Port collision check ───────────────────────────────────────────
      const pgPort = 5432
      if (await isPortInUse(pgPort)) {
        console.error(
          `[supatype] Port ${pgPort} is already in use. Another Postgres instance may be running.\n` +
            `  Check: lsof -i :${pgPort}`,
        )
        process.exit(1)
      }
      if (await isPortInUse(Number(serverPort))) {
        console.error(
          `[supatype] Port ${serverPort} is already in use. Another supatype-server may be running.\n` +
            `  Check: lsof -i :${serverPort}`,
        )
        process.exit(1)
      }
      if (await isPortInUse(Number(postgrestPort))) {
        console.error(
          `[supatype] Port ${postgrestPort} is already in use. Another service may be running.\n` +
            `  Check: lsof -i :${postgrestPort}`,
        )
        process.exit(1)
      }

      // ── 5–7. Start Postgres ───────────────────────────────────────────────
      let dbURL: string
      let stopPostgres: () => void | Promise<void>
      // pgBinDir is set on the native path and used to add DLL search path for
      // PostgREST on Windows (PostgREST links against libpq + SSL from MinGW).
      let pgBinDir: string | null = null

      if (provider === "docker") {
        const image = config.database.image ?? DEFAULT_DOCKER_IMAGE
        console.log(`[supatype] Starting Postgres via Docker (${image})...`)
        dockerPgStart({ image, projectName, port: pgPort })
        await dockerPgWaitReady(projectName, 30_000)
        console.log("[supatype] Postgres is ready.")
        dbURL = dockerDbUrl(projectName, pgPort)
        stopPostgres = () => dockerPgStop(projectName)
      } else {
        // native — resolve pg bin dir and manage with pg_ctl
        pgBinDir = await resolvePgBinDir(config)
        const dataDir = config.database.data_dir ?? join(stateRoot, "data")
        mkdirSync(dataDir, { recursive: true })
        const pgOpts = { pgBinDir, dataDir, port: pgPort, logPath: join(logsDir, "postgres.log") }

        console.log("[supatype] Initialising Postgres data directory...")
        initdb(pgOpts)
        console.log("[supatype] Starting Postgres...")
        pgStart(pgOpts)
        await pgWaitReady(pgOpts, 15_000)
        console.log("[supatype] Postgres is ready.")
        dbURL = `postgres://postgres:postgres@127.0.0.1:${pgPort}/${projectName}?sslmode=disable`
        stopPostgres = () => pgStop(pgOpts)

        // Create project database if it doesn't exist.
        const psqlBin    = join(pgBinDir, process.platform === "win32" ? "psql.exe"    : "psql")
        const createdbBin = join(pgBinDir, process.platform === "win32" ? "createdb.exe" : "createdb")
        const pgConnArgs = ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres"]
        const createDbResult = spawnSync(
          createdbBin,
          [...pgConnArgs, projectName],
          { stdio: "pipe", encoding: "utf8" },
        )
        if (createDbResult.status !== 0) {
          const stderr = createDbResult.stderr ?? ""
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
        const rolesSql = `
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon')
    THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated')
    THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role')
    THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Table-level privileges (RLS restricts rows; roles still need table access)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
-- Default privileges so tables created by the engine push inherit these grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
`
        spawnSync(psqlBin, [...pgConnArgs, "-d", projectName, "-c", rolesSql],
          { stdio: "pipe", encoding: "utf8" })
      }

      // ── 8. Engine: apply schema ───────────────────────────────────────────
      const schemaPath = schemaPathFromProject(config, cwd)
      const supatypeDir = join(cwd, ".supatype")
      const manifestPath = join(supatypeDir, "manifest.json")
      const adminConfigPath = join(supatypeDir, "admin-config.json")
      mkdirSync(supatypeDir, { recursive: true })

      const localStoragePath = config.storage?.provider !== "s3" ? join(stateRoot, "storage") : undefined
      // Native Postgres builds don't include PostGIS — skip geo fields rather than failing.
      const skipFieldKinds: ReadonlySet<string> = provider === "native" ? new Set(["geo", "vector"]) : new Set()

      await runSchemaPush(cwd, engineBin, schemaPath, dbURL, manifestPath, adminConfigPath, localStoragePath, skipFieldKinds).catch(
        (e: unknown) => console.error("[supatype] Initial schema push failed:", (e as Error).message),
      )

      // ── 9. Spawn supatype-server ──────────────────────────────────────────
      // GoTrue creates its auth schema in the project database so that auth.users
      // is co-located with public.* tables and visible from the SQL runner.
      // GoTrue migrations create tables with unqualified names and rely on
      // search_path=auth to resolve them into the auth schema.
      const authDbURL = dbURL.includes("?") ? `${dbURL}&search_path=auth` : `${dbURL}?search_path=auth`

      // Resolve edge functions config: only enable Deno if a functions dir exists.
      const functionsDir = functionsPathCandidatesFromProject(config, cwd).find(dir => existsSync(dir))
      const hasFunctionsDir = functionsDir !== undefined
      /** Always set when a functions dir exists so Studio admin API can list functions; Deno runtime is separate. */
      const denoFunctionsDir = hasFunctionsDir ? functionsDir : ""
      const functionRoutes = hasFunctionsDir && functionsDir !== undefined
        ? discoverTsFunctionsInDir(functionsDir)
        : []
      const denoServeScriptAbs = hasFunctionsDir && functionsDir !== undefined
        ? (writeDevFunctionsRouter(cwd, functionsDir, functionRoutes) ?? "")
        : ""

      let denoRuntimeAvailable = false
      let detectedDenoCommand: string | undefined
      if (hasFunctionsDir) {
        const denoDetection = detectDenoBinary(cwd, config.overrides?.deno)
        denoRuntimeAvailable = denoDetection.available
        detectedDenoCommand = denoDetection.command
        if (denoRuntimeAvailable) {
          console.log(`[supatype] Edge functions enabled (${functionsDir})`)
          if (detectedDenoCommand) {
            console.log(`[supatype] Deno runtime: ${detectedDenoCommand}`)
          }
          if (functionRoutes.length > 0) {
            console.log(
              `[supatype] Edge functions router: ${relative(cwd, denoServeScriptAbs) || ".supatype/functions-router.ts"} ` +
                `(${functionRoutes.length} function(s): ${functionRoutes.map(fn => fn.name).join(", ")})`,
            )
          } else {
            console.log("[supatype] Edge functions router not generated (no handler files discovered yet)")
          }
        } else {
          console.warn(
            `[supatype] ⚠  Found ${functionsDir} but Deno is not installed — edge functions will not run.\n` +
              "  Install Deno: https://docs.deno.com/runtime/getting_started/installation/\n" +
              "  (Functions still appear in Studio; invocations need Deno.)",
          )
        }
      }

      const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"
      const now = Math.floor(Date.now() / 1000)
      const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
      const anonKey        = signJwt({ ...jwtBase, role: "anon" },         LOCAL_JWT_SECRET)
      const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)


      const serverEnv: Record<string, string> = {
        // supatype-server outer layer
        SUPATYPE_MODE: config.server.mode ?? "dev",
        SUPATYPE_MANIFEST_PATH: manifestPath,
        SUPATYPE_ADMIN_CONFIG_PATH: adminConfigPath,
        SUPATYPE_POSTGREST_URL: `http://127.0.0.1:${postgrestPort}`,
        SUPATYPE_DENO_FUNCTIONS_DIR: denoFunctionsDir,
        ...(denoFunctionsDir !== "" ? { SUPATYPE_SHARED_ENV_FILE: resolve(denoFunctionsDir, ".env.local") } : {}),
        ...(detectedDenoCommand !== undefined ? { SUPATYPE_DENO_PATH: detectedDenoCommand } : {}),
        ...(denoServeScriptAbs !== ""
          ? { SUPATYPE_DENO_SERVE_SCRIPT: denoServeScriptAbs }
          : {}),
        SUPATYPE_URL: `http://localhost:${serverPort}`,
        SUPATYPE_ANON_KEY: anonKey,
        SUPATYPE_SERVICE_ROLE_KEY: serviceRoleKey,
        PORT: serverPort,
        // GoTrue required fields (sensible local-dev defaults)
        DATABASE_URL: authDbURL,
        SUPATYPE_SQL_DATABASE_URL: dbURL,
        GOTRUE_DB_DRIVER: "postgres",
        GOTRUE_JWT_SECRET: LOCAL_JWT_SECRET,
        GOTRUE_JWT_EXP: "3600",
        GOTRUE_JWT_AUD: "authenticated",
        GOTRUE_JWT_ADMIN_ROLES: "supatype_admin,service_role",
        API_EXTERNAL_URL: `http://localhost:${serverPort}/auth/v1`,
        GOTRUE_API_HOST: "localhost",
        GOTRUE_SITE_URL: `http://localhost:${serverPort}`,
        GOTRUE_MAILER_AUTOCONFIRM: "true",
        GOTRUE_LOG_LEVEL: "info",
        GOTRUE_DISABLE_SIGNUP: "false",
        ...(config.storage?.provider !== "s3" ? localStorageEnv(stateRoot) : {}),
        ...loadDotEnv(cwd),
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
          PGRST_DB_URI: dbURL,
          PGRST_DB_SCHEMA: "public, supatype",
          PGRST_DB_ANON_ROLE: "anon",
          PGRST_SERVER_PORT: postgrestPort,
          PGRST_SERVER_HOST: "127.0.0.1",
          PGRST_JWT_SECRET: serverEnv["GOTRUE_JWT_SECRET"] ?? "",
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
      const studioPort = 3002
      let studioProc: ProcessManager | null = null

      const studioOverride = config.overrides?.studio
      if (studioOverride) {
        const studioDir = resolve(cwd, studioOverride)
        // Run vite's JS entry directly via node — avoids .cmd/.sh wrapper spawn issues on Windows.
        const viteJs = join(studioDir, "node_modules", "vite", "bin", "vite.js")
        if (existsSync(viteJs)) {
          studioProc = new ProcessManager(
            process.execPath,
            [viteJs, "--port", String(studioPort), "--strictPort"],
            {
              label: "studio",
              pidDir,
              cwd: studioDir,
              colour: "\x1b[35m",
              env: {
                // Point the studio at the Vite dev server (same origin as the
                // browser) so all API requests are same-origin — CORS never fires.
                // Vite's dev proxy (configured via SUPATYPE_PROXY_TARGET) then
                // forwards those requests server-side to the actual backend.
                VITE_SUPATYPE_URL: `http://localhost:${studioPort}`,
                SUPATYPE_PROXY_TARGET: `http://localhost:${serverPort}`,
                // Studio is a developer tool — use service_role key to bypass
                // RLS so all tables and rows are visible regardless of policies.
                VITE_SUPATYPE_ANON_KEY: serviceRoleKey,
                VITE_SUPATYPE_SERVICE_ROLE_KEY: serviceRoleKey,
                VITE_BASE_PATH: "/",
              },
            },
          )
          studioProc.start()
        } else {
          console.warn(`[supatype] ⚠  Studio override set but vite not found at ${viteJs}. Run: pnpm install`)
        }
      }

      // ── Print status ──────────────────────────────────────────────────────
      console.log(`
[supatype] Services running:
  Postgres         ${dbURL}
  supatype-server  http://localhost:${serverPort}
    REST API       http://localhost:${serverPort}/rest/v1/
    Auth           http://localhost:${serverPort}/auth/v1/
    Storage        http://localhost:${serverPort}/storage/v1/
    Realtime       ws://localhost:${serverPort}/realtime/v1/${studioProc ? `\n  Studio           http://localhost:${studioPort}` : ""}

  API keys (local dev only):
    anon key       ${anonKey}
    service_role   ${serviceRoleKey}

  JWT secret: ${LOCAL_JWT_SECRET}

  Press Ctrl+C to stop.
`)


      // ── Shutdown handler ──────────────────────────────────────────────────
      const cleanup = async () => {
        console.log("\n[supatype] Shutting down...")
        await Promise.all([
          serverProc.stop(),
          postgrestProc?.stop(),
          studioProc?.stop(),
        ])
        await stopPostgres()
        process.exit(0)
      }
      process.once("SIGINT", cleanup)
      process.once("SIGTERM", cleanup)

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
            runSchemaPush(cwd, engineBin, schemaPath, dbURL, manifestPath, adminConfigPath, localStoragePath, skipFieldKinds).catch((e: unknown) =>
              console.error("[supatype] Schema push failed:", (e as Error).message),
            )
          }, 300)
        })
      }

      // Block until killed.
      await new Promise<never>(() => undefined)
    })
}

// ---------------------------------------------------------------------------
// Schema push (engine subprocess)
// ---------------------------------------------------------------------------

// Last successfully-pushed AST JSON — used to skip no-op re-fires.
let _lastPushedAst: string | null = null
// AST that failed on its last attempt — always retried even if content is unchanged.
let _lastFailedAst: string | null = null

async function runSchemaPush(
  cwd: string,
  engineBin: string,
  schemaPath: string,
  dbURL: string,
  manifestPath: string,
  adminConfigPath?: string,
  storagePath?: string,
  skipFieldKinds?: ReadonlySet<string>,
): Promise<void> {
  // Build AST JSON from schema file.
  const { loadSchemaAst } = await import("../config.js")
  let ast = loadSchemaAst(schemaPath, cwd)

  // Strip fields whose kind requires an unavailable Postgres extension.
  if (skipFieldKinds && skipFieldKinds.size > 0) {
    const { filtered, adapted } = adaptUnsupportedKinds(ast, skipFieldKinds)
    ast = filtered
    if (adapted.length > 0) {
      console.warn(
        `[supatype] ⚠  ${adapted.length} field(s) replaced with JSONB — required extensions not available:\n` +
        adapted.map((s: string) => `    ${s}`).join("\n"),
      )
    }
  }

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
  const pushResult = spawnSync(
    engineBin,
    ["push", "-i", astPath, "--database-url", dbURL, "--force"],
    { cwd, stdio: "inherit", encoding: "utf8" },
  )
  if (pushResult.status !== 0) {
    _lastFailedAst = astJson
    throw new Error(`Engine schema push failed (exit ${pushResult.status})`)
  }
  _lastPushedAst = astJson
  _lastFailedAst = null

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
    console.warn("[supatype] Manifest generation failed — server routing may be stale.")
  }

  // Generate admin config (for Studio). Engine writes to stdout.
  if (adminConfigPath) {
    const adminResult = spawnSync(
      engineBin,
      ["admin", "-i", astPath],
      { cwd, stdio: "pipe", encoding: "utf8" },
    )
    if (adminResult.status === 0 && adminResult.stdout) {
      writeFileSync(adminConfigPath, adminResult.stdout)
    }
  }

  console.log("[supatype] Schema applied.")
}

// ---------------------------------------------------------------------------
// Storage bucket provisioning (local dev only)
// ---------------------------------------------------------------------------

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

async function resolvePgBinDir(config: Awaited<ReturnType<typeof loadConfig>>): Promise<string> {
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
  const { cachePath } = await import("../binary-cache.js")
  const version = config.versions.postgres
  const { currentPlatform } = await import("../binary-cache.js")
  const platform = currentPlatform()

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
  const archiveName = `supatype-pg-${version}-${platform.os}-${platform.arch}${ext}`
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
// PostgREST resolver — downloads from GitHub releases if not cached
// ---------------------------------------------------------------------------

const POSTGREST_DEFAULT_VERSION = "12.2.3"
const POSTGREST_GITHUB = "https://github.com/PostgREST/postgrest/releases/download"

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

  const version = POSTGREST_DEFAULT_VERSION
  const platform = currentPlatform()
  const arch = platform.arch === "arm64" ? "aarch64" : "x86_64"
  const binName = platform.os === "windows" ? "postgrest.exe" : "postgrest"
  const cacheDir = cachePath("postgres", version).replace(/postgres/, "postgrest")
  const binPath = join(cacheDir, binName)
  const archiveName = platform.os === "windows"
    ? `postgrest-v${version}-windows-x64.zip`
    : platform.os === "darwin"
      ? `postgrest-v${version}-macos-${arch}.tar.xz`
      : `postgrest-v${version}-linux-static-${arch}.tar.xz`
  const archivePath = join(cacheDir, archiveName)

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
  const url = `${POSTGREST_GITHUB}/v${version}/${archiveName}`

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
// Local-dev JWT generator (no external dep — pure crypto)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// AST adaptation — replace extension-dependent fields with JSONB fallbacks
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
  ast: unknown,
  skipKinds: ReadonlySet<string>,
): { filtered: unknown; adapted: string[] } {
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

  return { filtered: { ...schema, models }, adapted }
}

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

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
