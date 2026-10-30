/**
 * postgres-ctl: wrappers around pg_ctl, initdb, and pg_isready for managing
 * a native Postgres installation.
 */

import { setTimeout as sleep } from "node:timers/promises"
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { pidAlive } from "./parent-watch.js"

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
  /** The project's database, where pg_cron and pg_net run their jobs. */
  database?: string
}

/** What the server's settings are decided from: the install, the keyspace and the database. */
type PgSettingsOptions = Pick<PgOptions, "pgBinDir" | "keyspacePort" | "keyspaceDatabase" | "database">

/**
 * Native Postgres bundles are built with prefix /usr/local/supatype-pg; dyld/ld
 * must load libpq and friends from the extracted lib/ next to bin/.
 */
export function pgSpawnEnv(
  pgBinDir: string,
  platform: NodeJS.Platform = process.platform,
  base: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const libDir = join(dirname(pgBinDir), "lib")
  const env = { ...base }
  if (platform === "darwin") {
    const prev = env.DYLD_LIBRARY_PATH ?? ""
    env.DYLD_LIBRARY_PATH = prev ? `${libDir}:${prev}` : libDir
  } else if (platform === "linux") {
    const prev = env.LD_LIBRARY_PATH ?? ""
    env.LD_LIBRARY_PATH = prev ? `${libDir}:${prev}` : libDir
    const caBundle = env.SSL_CERT_FILE || env.SSL_CERT_DIR ? undefined : hostCaBundle(exists)
    if (caBundle !== undefined) env.SSL_CERT_FILE = caBundle
  }
  return env
}

/** Where the Linux archive's OpenSSL looks for CA certificates: Debian's layout, built in. */
const BUILT_IN_CA_DIR = "/usr/lib/ssl/certs"

/** The CA bundle each family of distributions keeps, most common first. */
const HOST_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Alpine, Arch
  "/etc/pki/tls/certs/ca-bundle.crt", // Fedora, RHEL, CentOS
  "/etc/ssl/ca-bundle.pem", // openSUSE
  "/etc/ssl/cert.pem", // Alpine's other path, and the BSDs
]

/**
 * The host's CA bundle, for a Linux host without Debian's /usr/lib/ssl. The archive's OpenSSL,
 * which pg_net's libcurl verifies HTTPS with, looks only there, so on Fedora, RHEL or openSUSE every
 * request to an https URL failed its certificate check. OpenSSL reads SSL_CERT_FILE ahead of its
 * built-in paths; one the shell sets is left alone.
 */
function hostCaBundle(exists: (path: string) => boolean): string | undefined {
  if (exists(BUILT_IN_CA_DIR)) return undefined
  return HOST_CA_BUNDLES.find((path) => exists(path))
}

// ---------------------------------------------------------------------------
// initdb
// ---------------------------------------------------------------------------

/** How every local and host connection to a native cluster authenticates. */
export const NATIVE_AUTH_METHOD = "scram-sha-256"

/** What the Postgres build in a bin directory can do, as far as the native cluster's locale goes. */
export interface PgBuild {
  major: number | null
  /** Whether the build has ICU, so a cluster can collate by language. */
  icu: boolean
}

/**
 * initdb's arguments: the superuser `postgres`, with the password in `pwfile`, and password
 * authentication for every connection.
 *
 * This used to be `--auth trust`, which made the passwords the CLI generates decoration: any
 * local process could connect as any role, the superuser included, with any password or none.
 */
export function initdbArgs(dataDir: string, pwfile: string, build: PgBuild): string[] {
  return [
    "-D", dataDir,
    "--username", "postgres",
    `--pwfile=${pwfile}`,
    `--auth-local=${NATIVE_AUTH_METHOD}`,
    `--auth-host=${NATIVE_AUTH_METHOD}`,
    ...nativeLocaleArgs(build),
  ]
}

/**
 * UTF8, as the image's clusters are, on every platform. Given nothing, initdb and createdb took the
 * Windows code page, so a database refused Cyrillic, Greek, CJK and emoji. The image sorts by
 * language (`en_US.utf8`), which is no Windows locale name, so the collation is ICU's en-US, the
 * same order on every platform; LC_CTYPE and LC_COLLATE are C, which goes with any encoding. A
 * build without ICU sorts by code point: the builtin C.UTF-8 on Postgres 17, plain C before it.
 * A provider is named only where the version has it: `--locale-provider` came with 15, and `builtin`
 * with 17; an unknown version gets none.
 */
function nativeLocaleArgs(build: PgBuild): string[] {
  const utf8 = ["--encoding=UTF8", "--locale=C"]
  const major = build.major ?? 0
  if (build.icu && major >= 15) return [...utf8, "--locale-provider=icu", "--icu-locale=en-US"]
  if (major >= 17) return [...utf8, "--locale-provider=builtin", "--builtin-locale=C.UTF-8"]
  return utf8
}

/** createdb's arguments for the project database: as the cluster, from template0, whatever template1 holds. */
export function createdbArgs(connArgs: readonly string[], database: string, build: PgBuild): string[] {
  return [...connArgs, "--template=template0", ...nativeLocaleArgs(build), database]
}

/** The encoding of the database `connArgs` name, as psql reports it, or null when it cannot say. */
export function databaseEncoding(psqlBin: string, connArgs: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(psqlBin, [...connArgs, "-X", "-tAc", "SHOW server_encoding"], { encoding: "utf8", env })
  const encoding = (result.stdout ?? "").trim()
  return result.status === 0 && encoding !== "" ? encoding : null
}

/**
 * Whether a build has ICU, from `pg_config --configure`: named with `--with-icu`, or on by default
 * from Postgres 16 unless `--without-icu` turned it off. Nothing to read is no ICU.
 */
export function icuFromConfigure(configure: string, major: number | null): boolean {
  if (configure.includes("--without-icu")) return false
  return configure.includes("--with-icu") || (configure.trim() !== "" && major !== null && major >= 16)
}

/** Whether the ICU libraries (`libicu*`) sit in `pgBinDir` or the `lib` directory beside it. */
export function hasIcuLibraries(pgBinDir: string): boolean {
  return [pgBinDir, join(pgBinDir, "..", "lib")].some((dir) => {
    try {
      return readdirSync(dir).some((name) => name.toLowerCase().startsWith("libicu"))
    } catch {
      return false
    }
  })
}

/**
 * The major version and ICU support of the Postgres build in `pgBinDir`, from initdb and pg_config;
 * from the ICU libraries beside it when pg_config says nothing (a meson build's `--configure` is
 * empty).
 */
export function pgBuild(pgBinDir: string): PgBuild {
  const env = pgSpawnEnv(pgBinDir)
  const version = spawnSync(pgBin(pgBinDir, "initdb"), ["--version"], { encoding: "utf8", env })
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(version.stdout ?? "")
  const major = match?.[1] !== undefined ? Number(match[1]) : null
  const configure = spawnSync(pgBin(pgBinDir, "pg_config"), ["--configure"], { encoding: "utf8", env })
  const said = configure.status === 0 ? (configure.stdout ?? "").trim() : ""
  return { major, icu: said === "" ? hasIcuLibraries(pgBinDir) : icuFromConfigure(said, major) }
}

/** Says, once per new cluster, that a build without ICU sorts text by code point. */
function warnWithoutIcu(build: PgBuild): void {
  if (build.icu) return
  console.warn(
    "[supatype] ⚠  This Postgres build has no ICU, so the new cluster sorts text by code point " +
      "('Zebra' before 'apple'), not by language as the Docker image does.",
  )
}

/**
 * The warning for a project database an older CLI created in another encoding than UTF8, or null.
 * It is left as it is: re-encoding a database is not a thing to do to someone's data unasked.
 */
export function nonUtf8DatabaseWarning(encoding: string | null, database: string, dataDir: string): string | null {
  if (encoding === null || encoding === "UTF8") return null
  return (
    `[supatype] ⚠  Database "${database}" is ${encoding}, not UTF8, so text outside that encoding ` +
    "(Cyrillic, Greek, CJK, emoji) is refused. An older CLI created it so. To start fresh in UTF8, " +
    `stop dev and move or delete ${dataDir}: that removes this local database and everything in it.`
  )
}

/**
 * Prepare native dev's data directory, saying which of the two happens. It printed "Initialising
 * Postgres data directory..." on every start, which read as the cluster being made again; an
 * existing one never was ({@link initdb} returns at once when PG_VERSION is there). `build` is
 * asked only when a cluster is made.
 */
export function ensureCluster(opts: PgOptions, superuserPassword: string, build?: () => PgBuild): void {
  if (existsSync(join(opts.dataDir, "PG_VERSION"))) {
    console.log(`[supatype] Using the existing Postgres data directory ${opts.dataDir}`)
    return
  }
  console.log(`[supatype] Initialising a new Postgres data directory at ${opts.dataDir}...`)
  initdb(opts, superuserPassword, build)
}

/**
 * Initialise a Postgres data directory, with `superuserPassword` for `postgres`.
 * Does nothing if the data directory already contains a PG_VERSION file. `build` is asked only
 * when there is a cluster to create, so a caller that also needs it can ask once.
 */
export function initdb(opts: PgOptions, superuserPassword: string, build: () => PgBuild = () => pgBuild(opts.pgBinDir)): void {
  const pgVersionFile = join(opts.dataDir, "PG_VERSION")
  if (existsSync(pgVersionFile)) return // Already initialised.

  mkdirSync(opts.dataDir, { recursive: true })

  // initdb reads the password from a file, never an argument another process could see. The
  // file lives in a directory of its own, readable by this user only, for the length of the call.
  const pwDir = mkdtempSync(join(tmpdir(), "supatype-initdb-"))
  const pwfile = join(pwDir, "pw")
  try {
    writeFileSync(pwfile, `${superuserPassword}\n`, { mode: 0o600 })
    const built = build()
    warnWithoutIcu(built)
    const args = initdbArgs(opts.dataDir, pwfile, built)
    const result = spawnSync(pgBin(opts.pgBinDir, "initdb"), args, {
      stdio: "inherit",
      encoding: "utf8",
      env: pgSpawnEnv(opts.pgBinDir),
    })
    if (result.status !== 0) {
      throw new Error(`initdb failed (exit ${result.status})`)
    }
  } finally {
    rmSync(pwDir, { recursive: true, force: true })
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
 * Windows archive has none at all, because pgrx has no Windows target. Naming it in
 * `shared_preload_libraries` anyway would stop the server starting with "could
 * not access file", which would turn a missing cache into no database.
 */
export function nativeKeyspaceLibraryPresent(pgBinDir: string | null | undefined): boolean {
  return nativeLibraryPresent(pgBinDir, "pg_keyspace")
}

/**
 * What supatype-server is told about GraphQL for a native Postgres install: switched off when the
 * install has no pg_graphql, which no native archive carries (it is a pgrx extension, built only
 * into the supatype/postgres image). The server then answers `/graphql/v1` with 501
 * `graphql_unavailable` instead of PostgREST's "could not find the function
 * graphql_public.graphql". Asked of the filesystem, like the mask, so an install that does carry
 * the library keeps GraphQL.
 */
export function nativeGraphqlServerEnv(pgBinDir: string | null | undefined): Record<string, string> {
  return nativeLibraryPresent(pgBinDir, "pg_graphql") ? {} : { SUPATYPE_GRAPHQL_DISABLED: "true" }
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
 * keyspace silently dead. The failure lands in the postmaster log and nowhere
 * a developer is looking, so the port is chosen before the server starts
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
 * and refuses to serve when the order is wrong, deliberately, since RESP
 * would otherwise hand back rows the mask never rewrote. The rest sit between
 * them in the supatype/postgres image's order (PRELOAD_ORDER), each only when
 * the archive carries it: naming a library Postgres cannot find stops it, and
 * an archive from before they were bundled has to start as it did.
 *
 * The sizing is the measured dev profile: ~60 MiB of shared memory, against
 * the extension's own defaults of ~689 MiB before rings and row cache. It is
 * reserved at postmaster start whether or not anything caches, so a local
 * Postgres should not ask for a production keyspace. Durability is ephemeral
 * throughout: nothing in a dev keyspace is the only copy of anything.
 *
 * `wal_level=logical` because realtime decodes changes from a replication slot,
 * and initdb's default, `replica`, refuses to create one: native realtime never
 * ran, while dev announced it. Given on the command line, it beats
 * postgresql.conf, so a cluster created before this takes it at its next start.
 */
export function pgServerOptions(opts: PgOptions): string {
  return `-p ${opts.port} ${pgServerSettings(opts)}`
}

/**
 * {@link pgServerOptions} without the port: every setting a native Postgres starts with, for a
 * start that names its port elsewhere (the systemd unit's postgresql.conf).
 */
export function pgServerSettings(opts: PgSettingsOptions): string {
  const libs = preloadedLibraries(opts)
  // Room for pg_cron's and pg_net's background workers beside Postgres's own, as the image has.
  const parts = ["-c wal_level=logical", "-c max_worker_processes=16"]
  if (libs.length > 0) parts.push(`-c shared_preload_libraries=${libs.join(",")}`)
  if (libs.includes("pg_keyspace")) parts.push(...keyspaceOptions(opts))
  if (libs.includes("pg_cron")) parts.push(...databaseOption("cron.database_name", opts), "-c cron.use_background_workers=on")
  if (libs.includes("pg_net")) parts.push(...databaseOption("pg_net.database_name", opts), "-c pg_net.batch_size=200")
  return parts.join(" ")
}

/** `shared_preload_libraries` in the supatype/postgres image, outermost last. */
const PRELOAD_ORDER = [
  "pg_keyspace",
  "pg_stat_statements",
  "pg_cron",
  "pg_net",
  "plan_filter",
  "safeupdate",
  "supatype_mask",
] as const

/** The libraries to preload: each the archive carries, pg_keyspace only with a port to serve on. */
function preloadedLibraries(opts: PgSettingsOptions): string[] {
  return PRELOAD_ORDER.filter(
    (lib) => nativeLibraryPresent(opts.pgBinDir, lib) && (lib !== "pg_keyspace" || opts.keyspacePort !== undefined),
  )
}

/** `name` set to the project's database, which pg_cron and pg_net run their jobs in; none without one. */
function databaseOption(name: string, opts: PgSettingsOptions): string[] {
  return opts.database ? [`-c ${name}=${opts.database}`] : []
}

function keyspaceOptions(opts: PgSettingsOptions): string[] {
  return [
    `-c pg_keyspace.port=${opts.keyspacePort}`,
    "-c pg_keyspace.durability=ephemeral",
    "-c pg_keyspace.keys=50000",
    "-c pg_keyspace.ring_mb=8",
    "-c pg_keyspace.rowcache_mb=1",
    ...(opts.keyspaceDatabase ? [`-c pg_keyspace.database=${opts.keyspaceDatabase}`] : []),
  ]
}

export function start(opts: PgOptions): void {
  const logPath = opts.logPath ?? join(opts.dataDir, "postgres.log")
  removeStalePidFile(opts.dataDir)

  // `supatype_mask` is a planner hook and pg_keyspace registers background
  // workers and shared memory, so both have to be preloaded: `CREATE
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

  runPgCtlStart(opts, args, logPath)
}

/**
 * pg_ctl start, with its errors in a file beside the log, put in the error thrown when it fails.
 * Ctrl+C during the start made it print `could not send stop signal` to dev's terminal, which an
 * interrupted start has no reason to show. A file, not a pipe: Postgres inherits the handle, and
 * a pipe would hold this call until Postgres exits.
 */
function runPgCtlStart(opts: PgOptions, args: string[], logPath: string): void {
  const errPath = `${logPath}.pg_ctl-stderr`
  const fd = openSync(errPath, "w")
  try {
    const result = spawnSync(pgBin(opts.pgBinDir, "pg_ctl"), args, { stdio: ["ignore", "inherit", fd], env: pgSpawnEnv(opts.pgBinDir) })
    if (result.status !== 0) {
      const detail = readFileSync(errPath, "utf8").trim()
      throw new Error(`pg_ctl start failed (exit ${result.status})${detail ? `: ${detail}` : ""}`)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Removes `postmaster.pid` when no process has its pid, saying so. A start cut short by Ctrl+C
 * leaves one, and pg_ctl then warns that another server might be running. One whose process lives,
 * or that names no pid, is left for pg_ctl and Postgres to judge. True when it was removed.
 */
export function removeStalePidFile(dataDir: string, alive: (pid: number) => boolean = pidAlive): boolean {
  const pidFile = join(dataDir, "postmaster.pid")
  if (!existsSync(pidFile)) return false
  const firstLine = (readFileSync(pidFile, "utf8").split("\n")[0] ?? "").trim()
  const pid = /^\d+$/.test(firstLine) ? Number(firstLine) : 0
  if (pid <= 0 || alive(pid)) return false
  rmSync(pidFile, { force: true })
  console.log(`[supatype] Removed a stale postmaster.pid (process ${pid} is gone) from ${dataDir}.`)
  return true
}

/**
 * Stop Postgres using pg_ctl (fast mode), when it is running.
 *
 * Ctrl+C in a terminal reaches Postgres as well as `supatype dev`, so by the time dev stops it,
 * Postgres has usually shut itself down, and pg_ctl printed `PID file ... does not exist` on every
 * exit. No pid file means no server to stop. A stop that leaves the pid file in place did fail,
 * and says so, where it used to be ignored along with the harmless case; unless `quiet`, for an
 * interrupted start that ends with one line of its own.
 */
export function stop(opts: PgOptions, { quiet = false }: { quiet?: boolean } = {}): void {
  const pidFile = join(opts.dataDir, "postmaster.pid")
  if (!existsSync(pidFile)) return
  const result = spawnSync(pgBin(opts.pgBinDir, "pg_ctl"), ["stop", "-D", opts.dataDir, "-m", "fast", "--wait"], {
    stdio: "pipe",
    encoding: "utf8",
    env: pgSpawnEnv(opts.pgBinDir),
  })
  // Gone meanwhile: it finished shutting down on its own while pg_ctl looked.
  if (result.status === 0 || !existsSync(pidFile) || quiet) return
  const said = (result.stderr ?? "").trim() || (result.error !== undefined ? result.error.message : `exit ${result.status}`)
  console.warn(`[supatype] Could not stop Postgres (data directory ${opts.dataDir}): ${said}`)
}

/** Ask the running server to re-read its configuration, pg_hba.conf included. */
export function reload(opts: PgOptions): void {
  const result = spawnSync(pgBin(opts.pgBinDir, "pg_ctl"), ["reload", "-D", opts.dataDir], {
    stdio: "pipe",
    encoding: "utf8",
    env: pgSpawnEnv(opts.pgBinDir),
  })
  if (result.status !== 0) {
    throw new Error(`pg_ctl reload failed (exit ${result.status}): ${(result.stderr ?? "").trim()}`)
  }
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
export async function connectSucceeds(port: number, timeoutMs = 400, host = "127.0.0.1"): Promise<boolean> {
  const { connect } = await import("node:net")
  return new Promise((resolve) => {
    const socket = connect({ port, host })
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

/** Returns the full path to a Postgres binary, appending .exe on Windows. */
export function pgBin(binDir: string, name: string): string {
  return join(binDir, process.platform === "win32" ? `${name}.exe` : name)
}
