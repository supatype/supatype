/**
 * docker-postgres: manage a supatype/postgres Docker container for local dev.
 *
 * Used by `supatype dev` when database.provider = "docker".
 * The container is named supatype-{projectName} and persists data in a
 * named Docker volume (supatype-{projectName}-data) across restarts.
 */

import { setTimeout as sleep } from "node:timers/promises"
import {
  askDocker,
  askDockerSync,
  DOCKER_EXEC_TIMEOUT_MS,
  DOCKER_PULL_TIMEOUT_MS,
  DOCKER_QUERY_TIMEOUT_MS,
  type DockerAnswer,
} from "./docker-exec.js"
import { spawnFailureText } from "./error-message.js"
import { dockerEnv } from "./docker-env.js"

export interface DockerPgOptions {
  /** Docker image to run. Required: the caller resolves it (`postgresImageFor`, `RELEASE_IMAGES`). */
  image: string
  /** Project name: used to derive the container and volume names. */
  projectName: string
  /** Host port to bind to container's 5432. */
  port: number
  /** Superuser password (dev only). Defaults to "postgres". */
  password?: string
}

const PG_USER = "supatype_admin"
/** Must match `dockerPgStart` default `POSTGRES_PASSWORD`. */
const DEFAULT_DEV_PASSWORD = "postgres"

function dockerPgPsql(name: string, db: string, sql: string, password = DEFAULT_DEV_PASSWORD): Promise<DockerAnswer> {
  const secrets = dockerEnv({ PGPASSWORD: password })
  return askDocker(
    ["exec", ...secrets.args, name, "psql", "--no-password", "-U", PG_USER, "-d", db, "-tAc", sql],
    { env: secrets.env, timeoutMs: DOCKER_EXEC_TIMEOUT_MS },
  )
}

/** Derived container name for a project. */
export function containerName(projectName: string): string {
  return `supatype-${projectName}`
}

/**
 * Start the supatype/postgres Docker container.
 * Removes any stopped container with the same name before starting.
 * Throws if `docker run` exits non-zero.
 */
export function dockerPgStart(opts: DockerPgOptions): void {
  const { image, projectName, port, password = "postgres" } = opts
  const name = containerName(projectName)
  const volume = `${name}-data`

  // Remove any stopped container from a previous session.
  askDockerSync(["rm", "-f", name], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })

  const secrets = dockerEnv({
    POSTGRES_USER: PG_USER,
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: projectName,
  })
  // `run` pulls the image first when this machine does not have it.
  const result = askDockerSync(
    ["run", "-d", "--name", name, ...secrets.args, "-p", `${port}:5432`, "-v", `${volume}:/var/lib/postgresql/data`, image],
    { env: secrets.env, timeoutMs: DOCKER_PULL_TIMEOUT_MS },
  )

  if (result.status !== 0) {
    throw new Error(
      `Failed to start Docker container "${name}".\n  docker: ${spawnFailureText(result)}\n  Is Docker running?  docker info`,
    )
  }
}

/**
 * Stop the container (fast, does not remove it or the data volume).
 * Safe to call even if the container is not running.
 */
export function dockerPgStop(projectName: string): void {
  askDockerSync(["stop", containerName(projectName)], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
}

async function dockerPgLogsTail(name: string, tail = 120): Promise<string> {
  const logs = await askDocker(["logs", "--tail", String(tail), name], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
  return `${logs.stdout}${logs.stderr}`
}

async function dockerPgHealthStatus(name: string): Promise<string | undefined> {
  const format = "{{if .State.Health}}{{.State.Health.Status}}{{end}}"
  const inspect = await askDocker(["inspect", "-f", format, name], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })
  if (inspect.status !== 0) return undefined
  const status = inspect.stdout.trim()
  return status === "" ? undefined : status
}

/** True when the final post-init Postgres process is accepting connections. */
export function dockerPgPostInitServing(logs: string): boolean {
  const ready = "database system is ready to accept connections"
  const lastReady = logs.lastIndexOf(ready)
  if (lastReady === -1) return false

  const initDone = logs.lastIndexOf("PostgreSQL init process complete")
  if (initDone === -1) {
    // Reused data volume: this run did not re-run entrypoint init.
    return true
  }
  return initDone < lastReady
}

function migrateStillRunning(logs: string): boolean {
  return /99-supatype-migrate\.sh: running .+\.sql/.test(logs)
}

function psqlTruthy(stdout: string | undefined): boolean {
  const v = (stdout ?? "").replace(/\r/g, "").trim().toLowerCase()
  return v === "t" || v === "true"
}

const ANON_ROLE_SQL = "SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon')"

async function dockerPgHasAnonRole(name: string, projectName: string, password = DEFAULT_DEV_PASSWORD): Promise<boolean> {
  for (const db of [projectName, "postgres"]) {
    const result = await dockerPgPsql(name, db, ANON_ROLE_SQL, password)
    if (result.status === 0 && psqlTruthy(result.stdout)) return true
  }
  return false
}

async function dockerPgExecReady(name: string): Promise<boolean> {
  const ready = await askDocker(["exec", name, "pg_isready", "-U", PG_USER, "-q"], { timeoutMs: DOCKER_EXEC_TIMEOUT_MS })
  return ready.status === 0
}

/**
 * Poll until Postgres accepts connections and the image entrypoint init has
 * finished (anon/authenticated/service_role come from supatype-postgres
 * migrations/db/init-scripts/00000000000000-initial-schema.sql via migrate.sh).
 */
export async function dockerPgWaitReady(
  projectName: string,
  timeoutMs = 180_000,
  password = DEFAULT_DEV_PASSWORD,
): Promise<void> {
  const name = containerName(projectName)
  const deadline = Date.now() + timeoutMs
  let servingWithoutAnonMs = 0
  let lastPsqlDetail = ""

  while (Date.now() < deadline) {
    const health = await dockerPgHealthStatus(name)
    const logs = await dockerPgLogsTail(name)
    const serving =
      health === "healthy" ||
      dockerPgPostInitServing(logs) ||
      (await dockerPgExecReady(name))

    if (serving && !migrateStillRunning(logs)) {
      if (await dockerPgHasAnonRole(name, projectName, password)) return

      const probe = await dockerPgPsql(name, projectName, ANON_ROLE_SQL, password)
      lastPsqlDetail = [
        probe.status !== 0 ? `psql exit ${probe.status}` : "",
        probe.stderr.trim(),
        probe.stdout.trim() ? `stdout=${probe.stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("; ")

      const reusedVolume =
        logs.includes("database system is ready to accept connections") &&
        !logs.includes("PostgreSQL init process complete")

      if (reusedVolume) {
        servingWithoutAnonMs += 500
        if (servingWithoutAnonMs >= 5_000) throw staleVolumeError(name)
      } else {
        servingWithoutAnonMs = 0
      }
    } else {
      servingWithoutAnonMs = 0
    }

    await sleep(500)
  }

  const logs = await dockerPgLogsTail(name, 80)
  throw new Error(
    `Docker Postgres "${name}" did not finish image init within ${timeoutMs}ms.\n` +
      "  API roles (anon, authenticated, service_role) are created by the supatype/postgres\n" +
      "  entrypoint (99-supatype-migrate.sh), not by the CLI.\n" +
      "  If you upgraded the image, remove the stale volume:\n" +
      `    docker volume rm ${name}-data\n` +
      (lastPsqlDetail ? `  Last anon probe: ${lastPsqlDetail}\n` : "") +
      (logs ? `  logs (tail):\n${indent(logs)}\n` : ""),
  )
}

function staleVolumeError(name: string): Error {
  return new Error(
    `Docker Postgres "${name}" is up but API roles are missing.\n` +
      "  The data volume was initialised without supatype/postgres migrations (stale or wrong image).\n" +
      "  Remove the volume so first-boot 99-supatype-migrate.sh runs again:\n" +
      `    docker volume rm ${name}-data`,
  )
}

/** Connection string for the Docker container (local dev credentials). */
export function dockerDbUrl(projectName: string, port: number, password = DEFAULT_DEV_PASSWORD): string {
  // Host → published port. sqlx/libpq "prefer" can mis-handle SSL on some hosts (e.g. Docker Desktop on Windows).
  return `postgres://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${projectName}?sslmode=disable`
}

/**
 * DB URL for processes sharing the Postgres container network namespace
 * (supatype-server migrate in a one-shot container). Uses loopback inside the
 * container where pg_hba grants trust, avoids host-published-port SCRAM/SSL issues.
 */
export function dockerPgLoopbackDbUrl(projectName: string, password = DEFAULT_DEV_PASSWORD): string {
  return `postgres://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:5432/${projectName}?sslmode=disable`
}

/**
 * Run `supatype-server migrate` on the Postgres container network (loopback trust).
 * Used on Windows + database.provider docker, host-published :5432 breaks libpq TLS there.
 */
export function runAuthMigrationsViaDocker(
  pgContainerName: string,
  serverImage: string,
  migrateEnv: Record<string, string>,
): void {
  const secrets = dockerEnv(migrateEnv)
  // `run` may pull the server image first.
  const result = askDockerSync(
    ["run", "--rm", "--network", `container:${pgContainerName}`, ...secrets.args, serverImage, "migrate"],
    { env: secrets.env, timeoutMs: DOCKER_PULL_TIMEOUT_MS },
  )
  if (result.status !== 0) {
    throw new Error(`auth migrations failed in Docker (exit ${result.status ?? "unknown"}):\n${spawnFailureText(result)}`)
  }
}

function indent(s: string): string {
  return s
    .trimEnd()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")
}
