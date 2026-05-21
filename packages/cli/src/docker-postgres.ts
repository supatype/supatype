/**
 * docker-postgres — manage a supatype/postgres Docker container for local dev.
 *
 * Used by `supatype dev` when database.provider = "docker".
 * The container is named supatype-{projectName} and persists data in a
 * named Docker volume (supatype-{projectName}-data) across restarts.
 */

import { spawnSync } from "node:child_process"

export interface DockerPgOptions {
  /** Docker image to run. Defaults to supatype/postgres:17-latest. */
  image: string
  /** Project name — used to derive the container and volume names. */
  projectName: string
  /** Host port to bind to container's 5432. */
  port: number
  /** Superuser password (dev only). Defaults to "postgres". */
  password?: string
}

const PG_USER = "supatype_admin"

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

/**
 * Poll until Postgres accepts connections and the image entrypoint init has
 * finished (anon/authenticated/service_role come from supatype-postgres
 * migrations/db/init-scripts/00000000000000-initial-schema.sql via migrate.sh).
 */
export async function dockerPgWaitReady(
  projectName: string,
  timeoutMs = 30_000,
): Promise<void> {
  const name = containerName(projectName)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const ready = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", PG_USER, "-q"],
      { encoding: "utf8" },
    )
    if (ready.status === 0) {
      const initDone = spawnSync(
        "docker",
        [
          "exec", name,
          "psql", "-U", PG_USER, "-d", projectName, "-tAc",
          "SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon')",
        ],
        { encoding: "utf8", stdio: "pipe" },
      )
      if (initDone.status === 0 && initDone.stdout?.trim() === "t") return
    }
    await sleep(300)
  }

  const logs = spawnSync("docker", ["logs", "--tail", "30", name], {
    encoding: "utf8",
  })
  throw new Error(
    `Docker Postgres "${name}" did not finish image init within ${timeoutMs}ms.\n` +
      "  API roles (anon, authenticated, service_role) are created by the supatype/postgres\n" +
      "  entrypoint (99-supatype-migrate.sh), not by the CLI.\n" +
      "  If you upgraded the image, remove the stale volume:\n" +
      `    docker volume rm ${name}-data\n` +
      (logs.stdout ? `  stdout:\n${indent(logs.stdout)}\n` : "") +
      (logs.stderr ? `  stderr:\n${indent(logs.stderr)}\n` : ""),
  )
}

/** Connection string for the Docker container (local dev credentials). */
export function dockerDbUrl(projectName: string, port: number): string {
  // Local image has no TLS; sqlx/libpq default "prefer" can mis-handle the SSLRequest on some hosts.
  return `postgres://${PG_USER}:postgres@127.0.0.1:${port}/${projectName}?sslmode=disable`
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
