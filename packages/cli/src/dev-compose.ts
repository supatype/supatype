/**
 * `supatype dev` when `provider: docker` — full self-host Compose stack (Kong gateway).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { startProxyDevApp } from "./app/proxy-dev-app.js"
import { loadSchemaAst } from "./config.js"
import {
  COMPOSE_DEV_KONG_PORT,
  connectionString,
  projectRootFromConfig,
  resolveRuntimeProvider,
  schemaPathFromProject,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { signJwt } from "./jwt.js"
import { isPortInUse } from "./postgres-ctl.js"
import {
  COMPOSE_PINNED_IMAGE_ENV_KEYS,
  composeDockerImageEnv,
  composeProjectName,
  runDockerCompose,
  schemaEngineImageForPush,
  writeSelfHostCompose,
  type SelfHostComposePaths,
} from "./self-host-compose.js"
import { hasEngineOverride } from "./binary-cache.js"
import { startStudioViteDevServer } from "./studio-dev-server.js"
import { ensureEngine, engineRequest, type DiffResult } from "./engine-client.js"
import { endDevSession } from "./dev-session.js"
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

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

/** Default host port for compose Postgres when `overrides.engine` is set (devLocal). */
const COMPOSE_DEV_DB_PORT = 54329

/** Sync optional Docker image pins from config into `.env` (no JWT rotation). */
export function syncComposeImagePins(cwd: string, config: SupatypeProjectConfig): void {
  const imagePins = composeDockerImageEnv(config)
  const removeImageKeys = COMPOSE_PINNED_IMAGE_ENV_KEYS.filter((key) => !(key in imagePins))
  upsertEnvFile(cwd, imagePins, removeImageKeys)
}

export interface DevComposeOptions {
  watch: boolean
}

/** In-compose Postgres URL (SCRAM; not published to the host). */
export function composeDbUrl(): string {
  return "postgresql://supatype_admin:postgres@db:5432/supatype?sslmode=disable"
}

/**
 * Resolve the host Kong port for this project. Persisted in `.env` as
 * SUPATYPE_KONG_PORT so re-runs are stable; on first run it picks the default
 * (18473) or the next free port, so multiple projects can run concurrently.
 */
async function resolveDevDbPort(cwd: string): Promise<number> {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^SUPATYPE_DEV_DB_PORT=(\d+)/m)
    if (m && m[1]) return Number(m[1])
  }
  let port = COMPOSE_DEV_DB_PORT
  while (await isPortInUse(port)) port++
  return port
}

function readEnvValue(cwd: string, key: string, fallback: string): string {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))
    if (m?.[1]) return m[1].trim()
  }
  return fallback
}

/** Postgres DSN for compose db when published to the host (local engine push). */
function hostComposeDbUrl(cwd: string): string {
  const port = readEnvValue(cwd, "SUPATYPE_DEV_DB_PORT", String(COMPOSE_DEV_DB_PORT))
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const pass = readEnvValue(cwd, "POSTGRES_PASSWORD", "postgres")
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
  const kongPort = await resolveKongPort(cwd)
  const devDbPort = await resolveDevDbPort(cwd)

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })
  const up = runDockerCompose(paths.composePath, ["up", "-d", "db"], cwd, project, { quiet: true })
  if (up !== 0) process.exit(up)
  await waitComposeHealthy(paths, cwd, 120_000, project)
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

async function resolveKongPort(cwd: string): Promise<number> {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^SUPATYPE_KONG_PORT=(\d+)/m)
    if (m && m[1]) return Number(m[1])
  }
  let port = COMPOSE_DEV_KONG_PORT
  while (await isPortInUse(port)) port++
  return port
}

function upsertEnvFile(
  cwd: string,
  updates: Record<string, string>,
  removeKeys: readonly string[] = [],
): void {
  const envPath = join(cwd, ".env")
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const keys = new Set([...Object.keys(updates), ...removeKeys])
  const kept = existing
    .split("\n")
    .filter((line) => {
      const key = line.split("=")[0]?.trim()
      return key && line.includes("=") && !keys.has(key)
    })
  const merged = [...kept, ...Object.entries(updates).map(([key, value]) => `${key}=${value}`)]
  writeFileSync(envPath, `${merged.join("\n").trimEnd()}\n`, "utf8")
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
  const apiUrl = `http://localhost:${kongPort}`
  const imagePins = composeDockerImageEnv(config)
  const updates: Record<string, string> = {
    POSTGRES_USER: "supatype_admin",
    POSTGRES_PASSWORD: "postgres",
    POSTGRES_DB: "supatype",
    JWT_SECRET: LOCAL_JWT_SECRET,
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    PUBLIC_SUPATYPE_URL: apiUrl,
    SUPATYPE_KONG_PORT: String(kongPort),
    API_EXTERNAL_URL: apiUrl,
    SITE_URL: apiUrl,
    GOTRUE_MAILER_AUTOCONFIRM: "true",
    ...imagePins,
  }
  if (devDbPort !== undefined) {
    updates.SUPATYPE_DEV_DB_PORT = String(devDbPort)
  }
  const removeImageKeys = COMPOSE_PINNED_IMAGE_ENV_KEYS.filter((key) => !(key in imagePins))
  upsertEnvFile(cwd, updates, removeImageKeys)
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

async function waitKongReady(kongPort: number, maxSec: number): Promise<void> {
  const base = `http://localhost:${kongPort}`
  for (let i = 0; i < maxSec; i++) {
    try {
      const res = await fetch(`${base}/auth/v1/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Kong gateway at ${base} did not become ready within ${maxSec}s`)
}

async function provisionDockerStorageBuckets(
  ast: ExtractedSchemaAstV2,
  kongPort: number,
  serviceRoleKey: string,
): Promise<void> {
  await provisionBucketsFromAst(ast, `http://localhost:${kongPort}/storage/v1`, serviceRoleKey)
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

  try {
    await ensureEngine()
  } catch (err) {
    console.warn(
      `[supatype] Host engine unavailable — admin/types not refreshed: ${(err as Error).message}`,
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
      `[supatype] Admin config generation failed — Studio may show stale field widgets: ${(err as Error).message}`,
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
  // Always materialise on disk — schema-engine reads via bind mount; skip must not omit the write.
  writeFileSync(astPath, astJson)
  if (astJson === _lastPushedAst && astJson !== _lastFailedAst) return

  if (!existsSync(astPath)) {
    throw new Error(`Failed to write schema AST at ${astPath}`)
  }

  // Admin + types come from the AST only (no DB) — refresh before push so Studio stays
  // in sync even when migration fails (e.g. bad engine image, lossy column change).
  await refreshSchemaArtifacts(cwd, config, ast)

  if (hasEngineOverride(config)) {
    console.log("[supatype] Applying schema via local engine (overrides.engine)...")
    await ensureEngine()
    const pgSchema = config.schema?.pg_schema ?? "public"
    try {
      await engineRequest("/push", {
        ast,
        database_url: hostComposeDbUrl(cwd),
        schema: pgSchema,
        force: true,
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
  let push = await runComposeEnginePush(paths, cwd, composeProject, config)
  // Windows Docker bind mounts can lag briefly after the host write.
  if (push.status !== 0) {
    await new Promise((r) => setTimeout(r, 250))
    push = await runComposeEnginePush(paths, cwd, composeProject, config)
  }
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
    composeDbUrl(),
    "--force",
    "--non-interactive",
  )
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
    composeDbUrl(),
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
 * `overrides.engine` is set — then Postgres is published to the host and diff runs
 * through the local engine binary.
 */
export async function diffSchemaDocker(cwd: string, config: SupatypeProjectConfig): Promise<DiffResult> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("diffSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  const pgSchema = config.schema?.pg_schema ?? "public"

  if (hasEngineOverride(config)) {
    await ensureDockerDbPublishedForHostEngine(cwd, config)
    const schemaPath = schemaPathFromProject(config, cwd)
    const ast = loadSchemaAst(schemaPath, cwd)
    await ensureEngine()
    return engineRequest<DiffResult>("/diff", {
      ast,
      database_url: hostComposeDbUrl(cwd),
      schema: pgSchema,
    })
  }

  const kongPort = await resolveKongPort(cwd)
  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, undefined)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })

  const up = runDockerCompose(paths.composePath, ["up", "-d", "db"], cwd, project, { quiet: true })
  if (up !== 0) process.exit(up)
  await waitComposeHealthy(paths, cwd, 120_000, project)

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
 * `overrides.engine` is set — then Postgres is published to the host and push runs
 * through the local engine binary (AST v2, contributor builds).
 */
export async function pushSchemaDocker(cwd: string, config: SupatypeProjectConfig): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("pushSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd)
  const devDbPort = hasEngineOverride(config) ? await resolveDevDbPort(cwd) : undefined

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)
  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })

  console.log(`[supatype] provider: docker — applying schema via compose (project ${project})...`)
  const up = runDockerCompose(paths.composePath, ["up", "-d", "db"], cwd, project, { quiet: true })
  if (up !== 0) process.exit(up)
  await waitComposeHealthy(paths, cwd, 120_000, project)

  const schemaPath = schemaPathFromProject(config, cwd)
  const ast = loadSchemaAst(schemaPath, cwd)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project)

  const upGateway = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project, { quiet: true })
  if (upGateway !== 0) process.exit(upGateway)
  await waitKongReady(kongPort, 120)
  await provisionDockerStorageBuckets(ast, kongPort, serviceRoleKey)

  console.log("[supatype] Schema pushed.")
}

export async function runDevCompose(cwd: string, config: SupatypeProjectConfig, opts: DevComposeOptions): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("runDevCompose requires provider: docker")
  }

  // Per-project compose name + port isolate this project from any other Supatype
  // stack on the machine (own containers, volumes, network, and gateway port).
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd)
  const devDbPort = hasEngineOverride(config) ? await resolveDevDbPort(cwd) : undefined

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)

  ensureDevComposeEnv(cwd, config, anonKey, serviceRoleKey, kongPort, devDbPort)

  console.log(`[supatype] provider: docker — starting self-host Compose stack (project ${project}, gateway :${kongPort})...`)
  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })

  const upStatus = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project, { quiet: true })
  if (upStatus !== 0) {
    endDevSession()
    process.exit(upStatus)
  }

  console.log("[supatype] Waiting for Postgres (compose)...")
  await waitComposeHealthy(paths, cwd, 180_000, project)

  const schemaPath = schemaPathFromProject(config, cwd)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project).catch((e: unknown) =>
    console.error("[supatype] Initial schema push failed:", (e as Error).message),
  )

  console.log("[supatype] Waiting for API gateway...")
  await waitKongReady(kongPort, 120)

  const ast = loadSchemaAst(schemaPath, cwd)
  await provisionDockerStorageBuckets(ast, kongPort, serviceRoleKey)

  const pidDir = join(homedir(), ".supatype", "projects", config.project.name, "pid")
  mkdirSync(pidDir, { recursive: true })

  let studioProc: Awaited<ReturnType<typeof startStudioViteDevServer>> = null
  const studioOverride = config.overrides?.studio
  if (studioOverride) {
    studioProc = startStudioViteDevServer({
      cwd,
      studioOverride,
      pidDir,
      serviceRoleKey,
      proxyTarget: `http://localhost:${kongPort}`,
      viteSupatypeUrl: `http://localhost:${kongPort}`,
      basePath: "/studio/",
    })
    studioProc?.start()
    if (studioProc) {
      console.log("[supatype] Studio Vite dev server (overrides.studio) — live reload at /studio/")
    }
  }

  console.log(`
[supatype] Services running (Docker Compose · project ${project}):
  API (Kong)       http://localhost:${kongPort}
    REST API       http://localhost:${kongPort}/rest/v1/
    Auth           http://localhost:${kongPort}/auth/v1/
    Storage        http://localhost:${kongPort}/storage/v1/
    Realtime       ws://localhost:${kongPort}/realtime/v1/
  Studio           http://localhost:${kongPort}/studio/

  API keys (local dev only):
    anon key       ${anonKey}
    service_role   ${serviceRoleKey}

  Press Ctrl+C to stop.
`)

  const appProc = startProxyDevApp(cwd, config, pidDir)

  let schemaWatcher: import("node:fs").FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  registerDevShutdown(async () => {
    schemaWatcher?.close()
    schemaWatcher = null
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    console.log("[supatype] Shutting down compose...")
    await studioProc?.stop()
    await appProc?.stop()
    const downStatus = runDockerCompose(paths.composePath, ["down"], cwd, project, { quiet: true })
    if (downStatus === 0) {
      console.log("[supatype] Compose stack stopped.")
    } else {
      console.warn(`[supatype] Compose down exited with status ${downStatus}.`)
    }
  })

  if (opts.watch) {
    const schemaDir = join(projectRootFromConfig(config, cwd), config.schema?.path ?? "schema/index.ts", "..")
    console.log(`[supatype] Watching ${schemaDir} for changes...`)
    const { watch } = await import("node:fs")
    schemaWatcher = watch(schemaDir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith(".ts")) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
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
    console.warn("[supatype] Could not grant service_role access to auth.users — Studio relation preview may fail.")
  }
}
