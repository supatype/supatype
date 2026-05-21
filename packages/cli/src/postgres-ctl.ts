/**
 * postgres-ctl — wrappers around pg_ctl, initdb, and pg_isready for managing
 * a native Postgres installation.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export interface PgOptions {
  /** Absolute path to the directory containing pg_ctl, initdb, psql, etc. */
  pgBinDir: string
  /** Absolute path to the Postgres data directory (PGDATA). */
  dataDir: string
  /** Port Postgres should listen on. */
  port: number
  /** Path to write the postgres log file. */
  logPath?: string
}

/**
 * Native Postgres bundles are built with prefix /usr/local/supatype-pg; dyld/ld
 * must load libpq and friends from the extracted lib/ next to bin/.
 */
export function pgSpawnEnv(
  pgBinDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const libDir = join(dirname(pgBinDir), "lib")
  const env = { ...process.env } as NodeJS.ProcessEnv
  if (platform === "darwin") {
    const prev = env.DYLD_LIBRARY_PATH ?? ""
    env.DYLD_LIBRARY_PATH = prev ? `${libDir}:${prev}` : libDir
  } else if (platform === "linux") {
    const prev = env.LD_LIBRARY_PATH ?? ""
    env.LD_LIBRARY_PATH = prev ? `${libDir}:${prev}` : libDir
  }
  return env
}

// ---------------------------------------------------------------------------
// initdb
// ---------------------------------------------------------------------------

/**
 * Initialise a Postgres data directory.
 * Does nothing if the data directory already contains a PG_VERSION file.
 */
export function initdb(opts: PgOptions): void {
  const pgVersionFile = join(opts.dataDir, "PG_VERSION")
  if (existsSync(pgVersionFile)) return // Already initialised.

  mkdirSync(opts.dataDir, { recursive: true })

  const bin = pgBin(opts.pgBinDir, "initdb")
  const result = spawnSync(bin, ["-D", opts.dataDir, "--username", "postgres", "--auth", "trust"], {
    stdio: "inherit",
    encoding: "utf8",
    env: pgSpawnEnv(opts.pgBinDir),
  })

  if (result.status !== 0) {
    throw new Error(`initdb failed (exit ${result.status})`)
  }
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

/**
 * Start Postgres using pg_ctl.
 * Returns immediately once pg_ctl has handed off to the server process.
 */
export function start(opts: PgOptions): void {
  const bin = pgBin(opts.pgBinDir, "pg_ctl")
  const logPath = opts.logPath ?? join(opts.dataDir, "postgres.log")

  const args = [
    "start",
    "-D", opts.dataDir,
    "-l", logPath,
    "-o", `-p ${opts.port}`,
    "--wait",
  ]

  const result = spawnSync(bin, args, {
    stdio: "inherit",
    encoding: "utf8",
    env: pgSpawnEnv(opts.pgBinDir),
  })
  if (result.status !== 0) {
    throw new Error(`pg_ctl start failed (exit ${result.status})`)
  }
}

/**
 * Stop Postgres using pg_ctl (fast mode).
 */
export function stop(opts: PgOptions): void {
  const bin = pgBin(opts.pgBinDir, "pg_ctl")
  const result = spawnSync(bin, ["stop", "-D", opts.dataDir, "-m", "fast", "--wait"], {
    stdio: "inherit",
    encoding: "utf8",
    env: pgSpawnEnv(opts.pgBinDir),
  })
  // Ignore exit code — Postgres may already be stopped.
  void result
}

// ---------------------------------------------------------------------------
// waitReady
// ---------------------------------------------------------------------------

/**
 * Wait until Postgres is accepting connections.
 * Polls pg_isready every 200ms up to timeoutMs.
 * Throws if the timeout is exceeded.
 */
export async function waitReady(opts: PgOptions, timeoutMs = 10_000): Promise<void> {
  const bin = pgBin(opts.pgBinDir, "pg_isready")
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = spawnSync(bin, ["-p", String(opts.port), "-q"], {
      encoding: "utf8",
      env: pgSpawnEnv(opts.pgBinDir),
    })
    if (result.status === 0) return

    await sleep(200)
  }

  throw new Error(
    `Postgres did not become ready within ${timeoutMs}ms on port ${opts.port}`,
  )
}

// ---------------------------------------------------------------------------
// Port check
// ---------------------------------------------------------------------------

/**
 * Returns true if a TCP listener is already bound to port on 127.0.0.1.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  const { createServer } = await import("node:net")
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE")
    })
    server.once("listening", () => {
      server.close(() => resolve(false))
    })
    server.listen(port, "127.0.0.1")
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Returns the full path to a Postgres binary, appending .exe on Windows. */
function pgBin(binDir: string, name: string): string {
  return join(binDir, process.platform === "win32" ? `${name}.exe` : name)
}
