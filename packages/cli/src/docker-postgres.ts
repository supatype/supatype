/**
 * docker-postgres — manage a supatype/postgres Docker container for local dev.
 *
 * Used by `supatype dev` when database.provider = "docker".
 * The container is named supatype-{projectName} and persists data in a
 * named Docker volume (supatype-{projectName}-data) across restarts.
 */

import { spawnSync } from "node:child_process"

export interface DockerPgOptions {
  /** Docker image to run. Defaults to supatype/postgres:latest. */
  image: string
  /** Project name — used to derive the container and volume names. */
  projectName: string
  /** Host port to bind to container's 5432. */
  port: number
  /** Superuser password (dev only). Defaults to "postgres". */
  password?: string
}

const PG_USER = "supatype_admin"
/** Must match `dockerPgStart` default `POSTGRES_PASSWORD`. */
const DEFAULT_DEV_PASSWORD = "postgres"

function dockerPgPsql(
  name: string,
  db: string,
  sql: string,
  password = DEFAULT_DEV_PASSWORD,
) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e", `PGPASSWORD=${password}`,
      name,
      "psql", "--no-password", "-U", PG_USER, "-d", db, "-tAc", sql,
    ],
    { encoding: "utf8", stdio: "pipe" },
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
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" })

  const result = spawnSync(
    "docker",
    [
      "run", "-d",
      "--name", name,
      "-e", `POSTGRES_USER=${PG_USER}`,
      "-e", `POSTGRES_PASSWORD=${password}`,
      "-e", `POSTGRES_DB=${projectName}`,
      "-p", `${port}:5432`,
      "-v", `${volume}:/var/lib/postgresql/data`,
      image,
    ],
    { encoding: "utf8", stdio: "pipe" },
  )

  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim()
    throw new Error(
      `Failed to start Docker container "${name}".\n` +
        (detail ? `  docker: ${detail}\n` : "") +
        `  Is Docker running?  docker info`,
    )
  }
}

/**
 * Stop the container (fast — does not remove it or the data volume).
 * Safe to call even if the container is not running.
 */
export function dockerPgStop(projectName: string): void {
  spawnSync("docker", ["stop", containerName(projectName)], { encoding: "utf8" })
}

function dockerPgLogsTail(name: string, tail = 120): string {
  const logs = spawnSync(
    "docker",
    ["logs", "--tail", String(tail), name],
    { encoding: "utf8" },
  )
  return `${logs.stdout ?? ""}${logs.stderr ?? ""}`
}

function dockerPgHealthStatus(name: string): string | undefined {
  const inspect = spawnSync(
    "docker",
    ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", name],
    { encoding: "utf8", stdio: "pipe" },
  )
  if (inspect.status !== 0) return undefined
  const status = inspect.stdout?.trim()
  return status === "" ? undefined : status
}

/** True when the final post-init Postgres process is accepting connections. */
export function dockerPgPostInitServing(logs: string): boolean {
  const ready = "database system is ready to accept connections"
  const lastReady = logs.lastIndexOf(ready)
  if (lastReady === -1) return false

  const initDone = logs.lastIndexOf("PostgreSQL init process complete")
  if (initDone === -1) {
    // Reused data volume — this run did not re-run entrypoint init.
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

function dockerPgHasAnonRole(
  name: string,
  projectName: string,
  password = DEFAULT_DEV_PASSWORD,
): boolean {
  for (const db of [projectName, "postgres"]) {
    const result = dockerPgPsql(name, db, ANON_ROLE_SQL, password)
    if (result.status === 0 && psqlTruthy(result.stdout)) return true
  }
  return false
}

function dockerPgExecReady(name: string): boolean {
  const ready = spawnSync(
    "docker",
    ["exec", name, "pg_isready", "-U", PG_USER, "-q"],
    { encoding: "utf8", stdio: "pipe" },
  )
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
    const health = dockerPgHealthStatus(name)
    const logs = dockerPgLogsTail(name)
    const serving =
      health === "healthy" ||
      dockerPgPostInitServing(logs) ||
      dockerPgExecReady(name)

    if (serving && !migrateStillRunning(logs)) {
      if (dockerPgHasAnonRole(name, projectName, password)) return

      const probe = dockerPgPsql(name, projectName, ANON_ROLE_SQL, password)
      lastPsqlDetail = [
        probe.status !== 0 ? `psql exit ${probe.status}` : "",
        probe.stderr?.trim(),
        probe.stdout?.trim() ? `stdout=${probe.stdout.trim()}` : "",
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

  const logs = dockerPgLogsTail(name, 80)
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
  return `postgres://${PG_USER}:${password}@127.0.0.1:${port}/${projectName}?sslmode=disable`
}

/**
 * DB URL for processes sharing the Postgres container network namespace
 * (supatype-server migrate in a one-shot container). Uses loopback inside the
 * container where pg_hba grants trust — avoids host-published-port SCRAM/SSL issues.
 */
export function dockerPgLoopbackDbUrl(projectName: string, password = DEFAULT_DEV_PASSWORD): string {
  return `postgres://${PG_USER}:${password}@127.0.0.1:5432/${projectName}?sslmode=disable`
}

/**
 * Published Hub tag for local dev when CDN server version is not on Docker Hub yet.
 * Keep in sync with tests/integration/scripts/compose-smoke.sh.
 */
export const DEFAULT_SERVER_DOCKER_IMAGE = "supatype/server:latest"

/**
 * Run `supatype-server migrate` on the Postgres container network (loopback trust).
 * Used on Windows + database.provider docker — host-published :5432 breaks libpq TLS there.
 */
export function runGotrueMigrationsViaDocker(
  pgContainerName: string,
  serverImage: string,
  migrateEnv: Record<string, string>,
): void {
  const envArgs = Object.entries(migrateEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  const result = spawnSync(
    "docker",
    [
      "run", "--rm",
      "--network", `container:${pgContainerName}`,
      ...envArgs,
      serverImage,
      "migrate",
    ],
    { encoding: "utf8", stdio: "pipe" },
  )
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim()
    throw new Error(
      `GoTrue migrations failed in Docker (exit ${result.status ?? "unknown"})` +
        (detail ? `:\n${detail}` : ""),
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function indent(s: string): string {
  return s
    .trimEnd()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")
}
