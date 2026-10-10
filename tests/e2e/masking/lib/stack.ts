import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The running stack the suite drives, read from the project `masking-e2e.sh` brought up.
 *
 * Nothing here starts a stack: like the rest of tests/e2e, the suite points at one. The runner
 * exports MASKING_TIER and the Kong port; keys and database credentials come from the project's
 * own `.env`, which `supatype dev` wrote.
 */

export type Tier = 1 | 2

const here = dirname(fileURLToPath(import.meta.url))

export const PROJECT_DIR = resolve(process.env["MASKING_PROJECT_DIR"] ?? join(here, "..", "project"))

export function currentTier(): Tier {
  const raw = process.env["MASKING_TIER"]
  if (raw === "1" || raw === "2") return Number(raw) as Tier
  throw new Error("MASKING_TIER must be 1 or 2: the suite asserts different defects per tier")
}

function readEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[1], match[2].trim())
  }
  return entries
}

function required(env: Map<string, string>, key: string): string {
  const value = env.get(key)
  if (value === undefined || value === "") throw new Error(`${key} is missing from ${PROJECT_DIR}/.env`)
  return value
}

export interface StackInfo {
  baseUrl: string
  anonKey: string
  serviceKey: string
  dbContainer: string
  dbName: string
  dbPassword: string
  realtimeContainer: string
}

function loadStack(): StackInfo {
  const env = readEnvFile(join(PROJECT_DIR, ".env"))
  const kong = process.env["SUPATYPE_KONG_PORT"] ?? required(env, "SUPATYPE_KONG_PORT")
  const project = `supatype-${process.env["MASKING_PROJECT_NAME"] ?? "masking"}`
  return {
    // IPv4 explicitly: localhost resolves to ::1 first on some hosts.
    baseUrl: `http://127.0.0.1:${kong}`,
    anonKey: required(env, "ANON_KEY"),
    serviceKey: required(env, "SERVICE_ROLE_KEY"),
    dbContainer: `${project}-db-1`,
    dbName: required(env, "POSTGRES_DB"),
    dbPassword: required(env, "POSTGRES_PASSWORD"),
    realtimeContainer: `${project}-realtime-1`,
  }
}

let cached: StackInfo | undefined
export function stack(): StackInfo {
  cached ??= loadStack()
  return cached
}

/** One statement as `supatype_admin` in the project's database; rows come back tab-free, one per line. */
export function sql(statement: string): string {
  const s = stack()
  return execFileSync("docker", [
    "exec", "-e", `PGPASSWORD=${s.dbPassword}`, s.dbContainer,
    "psql", "-h", "127.0.0.1", "-U", "supatype_admin", "-d", s.dbName,
    "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", statement,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/**
 * Everything realtime has logged, stdout and stderr together, for the drop-logging check. The
 * whole log rather than a window: the container lives only as long as this run, and a time window
 * computed on the host is at the mercy of the clock skew between host and daemon.
 */
export function realtimeLogs(): string {
  const run = spawnSync("docker", ["logs", stack().realtimeContainer], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (run.status !== 0) throw new Error(`docker logs ${stack().realtimeContainer}: ${run.stderr}`)
  return `${run.stdout}${run.stderr}`
}

/** A value as an SQL literal: numbers as they are, strings single-quoted with quotes doubled. */
export function literal(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`
}
