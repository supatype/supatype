/**
 * Keep `DATABASE_URL` pointing at the port Postgres is actually published on.
 *
 * `SUPATYPE_DB_PORT` moves the host side of the compose port mapping, so a second project on one
 * machine can avoid a clash. `DATABASE_URL` is what every host-side script uses: seeds, one-off
 * psql, `supatype admin create-user --connection`. `init` writes the URL with 5432 in it and
 * nothing has ever reconciled the two.
 *
 * The result is a project that starts cleanly, serves every request, and fails the first time
 * someone runs `npm run seed`:
 *
 *   AggregateError [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:5432
 *
 * with the database listening on 5433 and nothing connecting the error to the port variable the
 * person set half an hour earlier. The generated `.env` even carries a comment conceding the
 * assumption: "Self-host compose uses the same DATABASE_URL when Postgres is published on
 * localhost:5432."
 *
 * The variable compose binds for the stack's layout is the source of truth: `SUPATYPE_DB_PORT` for
 * a self-host stack, `SUPATYPE_DEV_DB_PORT` for a dev one. The URL follows it.
 */
import { readEnvFile, upsertEnvFile } from "./env-file.js"

/** The `.env` key that moves the published Postgres port for a self-host stack. */
export const DB_PORT_ENV = "SUPATYPE_DB_PORT"

/**
 * The `.env` key that moves it for a dev-local stack.
 *
 * Two variables, two layouts: a self-host stack publishes Postgres at `SUPATYPE_DB_PORT`, and a
 * `supatype dev` stack publishes it at `SUPATYPE_DEV_DB_PORT` on loopback. Which one applies is the
 * layout of the stack being worked on ({@link composeDbPublish}), never which variables are present.
 *
 * Learned the hard way, twice. The first cut of this file read only `SUPATYPE_DB_PORT`, so on a dev
 * project with `SUPATYPE_DEV_DB_PORT=54330` it rewrote a correct `DATABASE_URL` to 5432. The second
 * let `SUPATYPE_DEV_DB_PORT` win whenever it was present, so a self-host push in a project that had
 * once run dev rewrote the self-host URL to the dev port.
 */
export const DEV_DB_PORT_ENV = "SUPATYPE_DEV_DB_PORT"

/**
 * The `.env` key naming the host a self-host stack's Postgres is reached at from outside the
 * stack, for the connection strings Studio shows. A dev stack binds loopback only and has no use
 * for it.
 */
export const DB_PUBLIC_HOST_ENV = "SUPATYPE_DB_PUBLIC_HOST"

/** What compose binds when neither variable is set, and what `init` writes into the URL. */
export const DEFAULT_DB_PORT = 5432

/**
 * The `.env` key naming the address a self-host stack publishes Postgres, the API server and
 * SeaweedFS on. Unset, they bind 127.0.0.1: the database is reached from the host, the other two
 * through Kong, and publishing them on every interface exposed all three on any server with no
 * firewall in front of it. `0.0.0.0` exposes them on every interface.
 */
export const PUBLISH_ADDRESS_ENV = "SUPATYPE_PUBLISH_ADDRESS"

/** The host side prefix of a self-host port mapping, as compose interpolates it. */
export const SELF_HOST_BIND = "${SUPATYPE_PUBLISH_ADDRESS:-127.0.0.1}:"

/** Where a dev stack publishes Postgres when `SUPATYPE_DEV_DB_PORT` is not set. */
export const COMPOSE_DEV_DB_PORT = 54329

/** How the compose `db` service is published on the host in one layout. */
export interface ComposeDbPublish {
  /** The variable compose reads the host port from. */
  envKey: typeof DEV_DB_PORT_ENV | typeof DB_PORT_ENV
  /** The port compose binds when that variable is not set. */
  defaultPort: number
  /** Prefix of the host side of the mapping: loopback in dev, {@link SELF_HOST_BIND} otherwise. */
  bindAddress: "127.0.0.1:" | typeof SELF_HOST_BIND
}

/**
 * The one definition of where Postgres is published, for a dev stack (`devLocal`) or a production
 * one. The compose template writes its port mapping from this and every host-side command reads
 * the port back through it, so the two cannot name different variables (M1: host commands read
 * `SUPATYPE_DEV_DB_PORT` on a production stack that publishes `SUPATYPE_DB_PORT`).
 */
export function composeDbPublish(devLocal: boolean): ComposeDbPublish {
  return devLocal
    ? { envKey: DEV_DB_PORT_ENV, defaultPort: COMPOSE_DEV_DB_PORT, bindAddress: "127.0.0.1:" }
    : { envKey: DB_PORT_ENV, defaultPort: DEFAULT_DB_PORT, bindAddress: SELF_HOST_BIND }
}

/** Hosts whose port is ours to correct. Anything else is somebody else's database. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** The port Postgres is published on for this project in one layout, from `.env`. */
export function publishedDbPort(env: Record<string, string>, devLocal: boolean): number {
  const { envKey, defaultPort } = composeDbPublish(devLocal)
  const raw = (env[envKey] ?? "").trim()
  const port = Number(raw)
  // A non-numeric or out-of-range value is the operator's to fix, and compose reports it far
  // better than we can. Falling back keeps this from inventing a port nothing listens on.
  return raw !== "" && Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultPort
}

/** What changed, for the caller to report. */
export interface DbPortSync {
  from: string
  to: string
  /** The variable the new port was read from, which is what the report must name. */
  envKey: ComposeDbPublish["envKey"]
}

/** The line every caller prints for a {@link DbPortSync}, naming the variable it read. */
export function databaseUrlSyncMessage(sync: DbPortSync): string {
  return `DATABASE_URL port ${sync.from} -> ${sync.to} in .env, to match ${sync.envKey}.`
}

/**
 * Rewrite `DATABASE_URL`'s port to match the port the stack's layout publishes Postgres on, and
 * report it.
 *
 * `devLocal` is the layout of the stack the caller is working with, never a guess from which
 * variables happen to be in `.env`: a project that once ran `supatype dev` keeps
 * `SUPATYPE_DEV_DB_PORT` there, and preferring it on a self-host push repointed every host-side
 * command (seed, admin) at the dev database.
 *
 * Returns null when there is nothing to do, which is the common case.
 *
 * Only touches a URL pointing at this machine. A project whose `DATABASE_URL` names a managed
 * Postgres elsewhere has a port that is nothing to do with our compose mapping, and rewriting it
 * would repoint the whole project at a database that does not exist.
 */
export function syncDatabaseUrlPort(cwd: string, devLocal: boolean): DbPortSync | null {
  const env = readEnvFile(cwd)
  const url = localDatabaseUrl(env["DATABASE_URL"])
  if (url === null) return null

  const wanted = String(publishedDbPort(env, devLocal))
  const current = url.port === "" ? String(DEFAULT_DB_PORT) : url.port
  if (current === wanted) return null

  url.port = wanted
  upsertEnvFile(cwd, { DATABASE_URL: url.toString() })
  return { from: current, to: wanted, envKey: composeDbPublish(devLocal).envKey }
}

/** True when `url` is a connection string to a database on this machine. */
export function isLocalDatabaseUrl(url: string): boolean {
  return localDatabaseUrl(url) !== null
}

/** `DATABASE_URL` parsed, when it names this machine; null when it is unset, malformed or remote. */
function localDatabaseUrl(value: string | undefined): URL | null {
  const raw = (value ?? "").trim()
  if (raw === "") return null
  try {
    const url = new URL(raw)
    return LOCAL_HOSTS.has(url.hostname) ? url : null
  } catch {
    // Malformed, so not ours to rewrite: a partial edit here would turn a typo into a URL that
    // parses and points somewhere wrong, which is harder to spot than the typo.
    return null
  }
}
