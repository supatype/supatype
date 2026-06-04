/**
 * `supatype dev` when `provider: docker` — full self-host Compose stack (Kong gateway).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { loadSchemaAst } from "./config.js"
import {
  COMPOSE_DEV_KONG_PORT,
  projectRootFromConfig,
  resolveRuntimeProvider,
  schemaPathFromProject,
  type SupatypeProjectConfig,
} from "./project-config.js"
import { signJwt } from "./jwt.js"
import { isPortInUse } from "./postgres-ctl.js"
import { composeProjectName, runDockerCompose, writeSelfHostCompose, type SelfHostComposePaths } from "./self-host-compose.js"

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

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

function ensureDevComposeEnv(cwd: string, anonKey: string, serviceRoleKey: string, kongPort: number): void {
  const envPath = join(cwd, ".env")
  const lines = [
    "POSTGRES_USER=supatype_admin",
    "POSTGRES_PASSWORD=postgres",
    "POSTGRES_DB=supatype",
    `JWT_SECRET=${LOCAL_JWT_SECRET}`,
    `ANON_KEY=${anonKey}`,
    `SERVICE_ROLE_KEY=${serviceRoleKey}`,
    `SUPATYPE_KONG_PORT=${kongPort}`,
    `API_EXTERNAL_URL=http://localhost:${kongPort}`,
    "GOTRUE_MAILER_AUTOCONFIRM=true",
  ]
  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, "utf8")
    const missing = lines.filter((line) => {
      const key = line.split("=")[0]!
      return !existing.split("\n").some((l) => l.startsWith(`${key}=`))
    })
    if (missing.length > 0) {
      writeFileSync(envPath, `${existing.trimEnd()}\n${missing.join("\n")}\n`, "utf8")
    }
    return
  }
  writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8")
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

let _lastPushedAst: string | null = null
let _lastFailedAst: string | null = null

async function runComposeSchemaPush(
  cwd: string,
  config: SupatypeProjectConfig,
  paths: SelfHostComposePaths,
  schemaPath: string,
  composeProject: string,
): Promise<void> {
  const ast = loadSchemaAst(schemaPath, cwd)
  const astJson = JSON.stringify(ast)
  if (astJson === _lastPushedAst && astJson !== _lastFailedAst) return

  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const astPath = join(supatypeDir, "schema.ast.json")
  writeFileSync(astPath, astJson)

  console.log("[supatype] Applying schema via compose schema-engine...")
  const status = runDockerCompose(
    paths.composePath,
    [
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
    ],
    cwd,
    composeProject,
  )
  if (status !== 0) {
    _lastFailedAst = astJson
    throw new Error(`Engine schema push failed (exit ${status})`)
  }
  _lastPushedAst = astJson
  _lastFailedAst = null

  const adminConfigPath = join(supatypeDir, "admin-config.json")

  // Generate the typed client and write it to the configured output path,
  // capturing stdout so the generated code is saved to a file rather than
  // streamed to the dev console.
  const typesPath = config.output?.types
  if (typeof typesPath === "string" && typesPath.trim().length > 0) {
    const gen = spawnSync(
      "docker",
      buildComposeRunArgs(
        paths,
        cwd,
        ["generate", "-i", "/project/.supatype/schema.ast.json", "--log", "error"],
        composeProject,
      ),
      { encoding: "utf8", cwd: dirname(paths.composePath) },
    )
    if (gen.status === 0 && typeof gen.stdout === "string" && gen.stdout.includes("export type")) {
      const marker = gen.stdout.indexOf("// Generated by supatype-engine")
      const ts = (marker >= 0 ? gen.stdout.slice(marker) : gen.stdout).trimStart()
      const hostPath = join(cwd, typesPath)
      mkdirSync(dirname(hostPath), { recursive: true })
      writeFileSync(hostPath, ts)
      console.log(`[supatype] Types written to ${typesPath}`)
    } else {
      console.warn("[supatype] Type generation produced no output.")
    }
  }

  const adminResult = spawnSync(
    "docker",
    buildComposeRunArgs(paths, cwd, ["admin", "-i", "/project/.supatype/schema.ast.json"], composeProject),
    { encoding: "utf8", cwd: dirname(paths.composePath) },
  )
  if (adminResult.status === 0 && adminResult.stdout) {
    writeFileSync(adminConfigPath, adminResult.stdout)
  }
  console.log("[supatype] Schema applied.")
}

function buildComposeRunArgs(paths: SelfHostComposePaths, projectRoot: string, engineArgs: string[], composeProject: string): string[] {
  const envFile = join(projectRoot, ".env")
  const args = ["compose", "-p", composeProject, "-f", paths.composePath]
  if (existsSync(envFile)) args.push("--env-file", envFile)
  args.push("--profile", "tools", "run", "--rm", "schema-engine", ...engineArgs)
  return args
}

/**
 * `supatype push` when `provider: docker`. The compose Postgres is not published
 * to the host, so we apply the schema through the in-compose schema-engine
 * (bringing the db up first if needed) rather than the native engine + DSN path.
 */
export async function pushSchemaDocker(cwd: string, config: SupatypeProjectConfig): Promise<void> {
  if (resolveRuntimeProvider(config) !== "docker") {
    throw new Error("pushSchemaDocker requires provider: docker")
  }
  const project = composeProjectName(config.project.name)
  const kongPort = await resolveKongPort(cwd)

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)
  ensureDevComposeEnv(cwd, anonKey, serviceRoleKey, kongPort)

  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })

  console.log(`[supatype] provider: docker — applying schema via compose (project ${project})...`)
  const up = runDockerCompose(paths.composePath, ["up", "-d", "db"], cwd, project)
  if (up !== 0) process.exit(up)
  await waitComposeHealthy(paths, cwd, 120_000, project)

  const schemaPath = schemaPathFromProject(config, cwd)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project)
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

  const now = Math.floor(Date.now() / 1000)
  const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
  const anonKey = signJwt({ ...jwtBase, role: "anon" }, LOCAL_JWT_SECRET)
  const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, LOCAL_JWT_SECRET)

  ensureDevComposeEnv(cwd, anonKey, serviceRoleKey, kongPort)

  console.log(`[supatype] provider: docker — starting self-host Compose stack (project ${project}, gateway :${kongPort})...`)
  const paths = writeSelfHostCompose(cwd, config, { devLocal: true })

  const upStatus = runDockerCompose(paths.composePath, ["up", "-d"], cwd, project)
  if (upStatus !== 0) process.exit(upStatus)

  console.log("[supatype] Waiting for Postgres (compose)...")
  await waitComposeHealthy(paths, cwd, 180_000, project)

  const schemaPath = schemaPathFromProject(config, cwd)
  await runComposeSchemaPush(cwd, config, paths, schemaPath, project).catch((e: unknown) =>
    console.error("[supatype] Initial schema push failed:", (e as Error).message),
  )

  console.log("[supatype] Waiting for API gateway...")
  await waitKongReady(kongPort, 120)

  console.log(`
[supatype] Services running (Docker Compose · project ${project}):
  API (Kong)       http://localhost:${kongPort}
    REST API       http://localhost:${kongPort}/rest/v1/
    Auth           http://localhost:${kongPort}/auth/v1/
    Storage        http://localhost:${kongPort}/storage/v1/
    Realtime       ws://localhost:${kongPort}/realtime/v1/

  API keys (local dev only):
    anon key       ${anonKey}
    service_role   ${serviceRoleKey}

  Press Ctrl+C to stop.
`)

  const cleanup = () => {
    console.log("\n[supatype] Shutting down compose...")
    runDockerCompose(paths.composePath, ["down"], cwd, project)
    process.exit(0)
  }
  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)

  if (opts.watch) {
    const schemaDir = join(projectRootFromConfig(config, cwd), config.schema?.path ?? "schema/index.ts", "..")
    console.log(`[supatype] Watching ${schemaDir} for changes...`)
    const { watch } = await import("node:fs")
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    watch(schemaDir, { recursive: true }, (_eventType, filename) => {
      if (!filename?.endsWith(".ts")) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        console.log(`\n[supatype] Change detected in ${filename}, pushing schema...`)
        runComposeSchemaPush(cwd, config, paths, schemaPath, project).catch((e: unknown) =>
          console.error("[supatype] Schema push failed:", (e as Error).message),
        )
      }, 300)
    })
  }

  await new Promise<never>(() => undefined)
}
