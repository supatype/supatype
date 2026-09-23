/**
 * postgres-ctl: wrappers around pg_ctl, initdb, and pg_isready for managing
 * a native Postgres installation.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"

export interface PgOptions {
  /** Absolute path to the directory containing pg_ctl, initdb, psql, etc. */
  pgBinDir: string
  /** Absolute path to the Postgres data directory (PGDATA). */
  dataDir: string
  /** Port Postgres should listen on. */
  port: number
  /** Path to write the postgres log file. */
  logPath?: string
  /**
   * Port for the RESP keyspace, when the native install carries pg_keyspace.
   *
   * Absent means do not serve RESP at all: `supatype dev` then starts the
   * Valkey sidecar instead, as it always has.
   */
  keyspacePort?: number
  /** Database durable keys are written to. Ignored while everything is ephemeral. */
  keyspaceDatabase?: string
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
/**
 * Whether a native Postgres install carries the masking library.
 *
 * Asked of the filesystem rather than assumed from the provider, because a developer with an archive
 * downloaded before the library was bundled has a native Postgres *without* it. Assuming otherwise
 * would select tier 1 and their next push would be refused by the capability probe.
 *
 * Two layouts: Linux and macOS put extension libraries in `lib/`, the Windows archive in
 * `lib/postgresql/`.
 */
export function nativeMaskLibraryPresent(pgBinDir: string | null | undefined): boolean {
  return nativeLibraryPresent(pgBinDir, "supatype_mask")
}

/**
 * Whether a native Postgres install carries the RESP keyspace.
 *
 * Asked of the filesystem for the same reason as the mask: an archive
 * downloaded before pg_keyspace was bundled has a Postgres without it, and the
 * Windows archive has none at all — pgrx has no Windows target. Naming it in
 * `shared_preload_libraries` anyway would stop the server starting with "could
 * not access file", which would turn a missing cache into no database.
 */
export function nativeKeyspaceLibraryPresent(pgBinDir: string | null | undefined): boolean {
  return nativeLibraryPresent(pgBinDir, "pg_keyspace")
}

/**
 * Two layouts: Linux and macOS put extension libraries in `lib/`, the Windows
 * archive in `lib/postgresql/`.
 */
function nativeLibraryPresent(pgBinDir: string | null | undefined, stem: string): boolean {
  if (!pgBinDir) return false
  const prefix = resolvePath(pgBinDir, "..")
  return [`${stem}.so`, `${stem}.dylib`, `${stem}.dll`].some(
    (lib) =>
      existsSync(join(prefix, "lib", lib)) || existsSync(join(prefix, "lib", "postgresql", lib)),
  )
}

/**
 * Where the native RESP keyspace looks for a free port, and how far it looks.
 *
 * 6379 first, because that is what a developer's tooling and the Valkey
 * sidecar before it both used, so the familiar port stays the usual answer.
 */
export const KEYSPACE_PORT_BASE = 6379
export const KEYSPACE_PORT_SPAN = 10

/**
 * The first free port in [base, base + span), or null when they are all taken.
 *
 * Binding a port something else already holds would leave Postgres up and the
 * keyspace silently dead — the failure lands in the postmaster log and nowhere
 * a developer is looking — so the port is chosen before the server starts
 * rather than fixed and hoped for.
 */
export async function firstFreePort(base: number, span: number): Promise<number | null> {
  for (let port = base; port < base + span; port++) {
    if (!(await isPortInUse(port))) return port
  }
  return null
}

/**
 * The `-o` options pg_ctl passes to the server.
 *
 * Separated from the spawn so the decision is testable. What goes in here is
 * decided by which libraries the archive happens to carry, which is exactly
 * the kind of thing that is wrong in one combination nobody runs locally.
 *
 * Order in `shared_preload_libraries` is load-bearing: pg_keyspace first, then
 * supatype_mask, so the mask stays outermost. pg_keyspace checks this itself
 * and refuses to serve when the order is wrong — deliberately, since RESP
 * would otherwise hand back rows the mask never rewrote.
 *
 * The sizing is the measured dev profile: ~60 MiB of shared memory, against
 * the extension's own defaults of ~689 MiB before rings and row cache. It is
 * reserved at postmaster start whether or not anything caches, so a local
 * Postgres should not ask for a production keyspace. Durability is ephemeral
 * throughout: nothing in a dev keyspace is the only copy of anything.
 */
export function pgServerOptions(opts: PgOptions): string {
  const mask = nativeMaskLibraryPresent(opts.pgBinDir)
  const keyspace = opts.keyspacePort !== undefined && nativeKeyspaceLibraryPresent(opts.pgBinDir)

  const libs = [...(keyspace ? ["pg_keyspace"] : []), ...(mask ? ["supatype_mask"] : [])]
  const parts = [`-p ${opts.port}`]
  if (libs.length > 0) parts.push(`-c shared_preload_libraries=${libs.join(",")}`)
  if (keyspace) {
    parts.push(
      `-c pg_keyspace.port=${opts.keyspacePort}`,
      "-c pg_keyspace.durability=ephemeral",
      "-c pg_keyspace.keys=50000",
      "-c pg_keyspace.ring_mb=8",
      "-c pg_keyspace.rowcache_mb=1",
    )
    if (opts.keyspaceDatabase) {
      parts.push(`-c pg_keyspace.database=${opts.keyspaceDatabase}`)
    }
  }
  return parts.join(" ")
}

export function start(opts: PgOptions): void {
  const bin = pgBin(opts.pgBinDir, "pg_ctl")
  const logPath = opts.logPath ?? join(opts.dataDir, "postgres.log")

  // `supatype_mask` is a planner hook and pg_keyspace registers background
  // workers and shared memory, so both have to be preloaded — `CREATE
  // EXTENSION` alone does nothing for either. Only when the archive actually
  // carries them; see pgServerOptions.
  //
  // Native Postgres was started with no preloaded libraries at all until the
  // mask, which is why field rules could not be enforced on the default
  // `supatype dev`.
  const args = [
    "start",
    "-D", opts.dataDir,
    "-l", logPath,
    "-o", pgServerOptions(opts),
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
  // Ignore exit code: Postgres may already be stopped.
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
 * Can this port be bound, on the addresses that matter?
 *
 *   - `0.0.0.0` is what Docker publishes on and what compose has to bind.
 *   - `127.0.0.1` catches a listener bound to loopback only, which a wildcard bind can be allowed
 *     to sit alongside on some platforms.
 */
async function bindFails(port: number, host: string): Promise<boolean> {
  const { createServer } = await import("node:net")
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (err: NodeJS.ErrnoException) => {
      // EADDRINUSE: something is listening. EACCES: Windows excluded/reserved port range.
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES")
    })
    server.once("listening", () => {
      server.close(() => resolve(false))
    })
    server.listen(port, host)
  })
}

/**
 * Is something answering on this port?
 *
 * Binding is not enough on its own. Docker Desktop publishes through a proxy that does not hold a
 * bind a normal socket can see, so `bindFails` succeeds while nginx on that port answers HTTP 200.
 * Measured on Windows: bind says free, curl says 200. `supatype dev` believed the bind, handed the
 * port to compose, and compose failed with "Bind for 0.0.0.0:5432 failed: port is already
 * allocated". Connecting is what notices.
 */
async function connectSucceeds(port: number, timeoutMs = 400): Promise<boolean> {
  const { connect } = await import("node:net")
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const done = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

/**
 * True when the port cannot be used for a new listener.
 *
 * Either signal is enough. Reporting a port busy when it is usable costs an increment in
 * `findNextFreePort`; reporting it free when it is not costs a failed `docker compose up`, which is
 * the failure this exists to prevent.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  if (await connectSucceeds(port)) return true
  return (await bindFails(port, "0.0.0.0")) || (await bindFails(port, "127.0.0.1"))
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
