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
 * `SUPATYPE_DB_PORT` is the source of truth, because it is what compose binds. The URL follows it.
 */
import { readEnvFile, upsertEnvFile } from "./env-file.js"

/** The `.env` key that moves the published Postgres port for a self-host stack. */
export const DB_PORT_ENV = "SUPATYPE_DB_PORT"

/**
 * The `.env` key that moves it for a dev-local stack, and which takes precedence.
 *
 * Two variables, two deployment shapes: an ordinary self-host stack publishes Postgres at
 * `SUPATYPE_DB_PORT`, and a project with `overrides.engine` publishes it at
 * `SUPATYPE_DEV_DB_PORT` so the host-side engine binary can reach it. Its presence is what marks
 * the second shape, so it wins where both are set.
 *
 * Learned the hard way. The first cut of this file read only `SUPATYPE_DB_PORT`, so on a project
 * with `SUPATYPE_DEV_DB_PORT=54330` it rewrote a correct `DATABASE_URL` to 5432, where nothing was
 * listening. It fixed the bug it was written for and reintroduced it through the other door, which
 * is the exact failure this file exists to prevent.
 */
export const DEV_DB_PORT_ENV = "SUPATYPE_DEV_DB_PORT"

/** What compose binds when neither variable is set, and what `init` writes into the URL. */
export const DEFAULT_DB_PORT = 5432

/** Hosts whose port is ours to correct. Anything else is somebody else's database. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** The port Postgres is published on for this project, from `.env`. */
export function publishedDbPort(env: Record<string, string>): number {
  // Dev-local first: its presence is what says this project publishes for a host-side engine.
  for (const key of [DEV_DB_PORT_ENV, DB_PORT_ENV]) {
    const raw = (env[key] ?? "").trim()
    if (raw === "") continue
    const port = Number(raw)
    // A non-numeric or out-of-range value is the operator's to fix, and compose reports it far
    // better than we can. Falling through keeps this from inventing a port nothing listens on.
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  }
  return DEFAULT_DB_PORT
}

/** What changed, for the caller to report. */
export interface DbPortSync {
  from: string
  to: string
}

/**
 * Rewrite `DATABASE_URL`'s port to match `SUPATYPE_DB_PORT`, and report it.
 *
 * Returns null when there is nothing to do, which is the common case.
 *
 * Only touches a URL pointing at this machine. A project whose `DATABASE_URL` names a managed
 * Postgres elsewhere has a port that is nothing to do with our compose mapping, and rewriting it
 * would repoint the whole project at a database that does not exist.
 */
export function syncDatabaseUrlPort(cwd: string): DbPortSync | null {
  const env = readEnvFile(cwd)
  const raw = (env["DATABASE_URL"] ?? "").trim()
  if (raw === "") return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Malformed, so not ours to rewrite: a partial edit here would turn a typo into a URL that
    // parses and points somewhere wrong, which is harder to spot than the typo.
    return null
  }

  if (!LOCAL_HOSTS.has(url.hostname)) return null

  const wanted = String(publishedDbPort(env))
  const current = url.port === "" ? String(DEFAULT_DB_PORT) : url.port
  if (current === wanted) return null

  url.port = wanted
  upsertEnvFile(cwd, { DATABASE_URL: url.toString() })
  return { from: current, to: wanted }
}
