/**
 * Who wrote `.env`'s `DATABASE_URL`: the CLI, or a person.
 *
 * `init` writes a URL for the Docker stack, and every host command reads `.env`'s URL ahead of the
 * project's own database. A project made for Docker and then run native therefore sent `push`,
 * `seed` and `admin` to the Docker database, where nothing listened (local test N1). Nothing could
 * tell that URL from one a person wrote to reach their own Postgres, which must always win.
 *
 * So the CLI marks every URL it writes, with the managed marker `.env` already uses, and a URL it
 * wrote belongs to whichever provider the project runs. A `.env` from before the marker counts as
 * the CLI's when it is exactly the shape `init` and Docker dev write: the bundled user, `.env`'s
 * POSTGRES_PASSWORD, its database and a host on this machine, on any port.
 */
import { envValueOwner, readEnvFile, upsertEnvFile } from "./env-file.js"
import { DEFAULT_DB_PORT, isLocalDatabaseUrl } from "./db-port.js"
import { connectSucceeds } from "./postgres-ctl.js"
import { BUNDLED_DB_USER } from "./local-secrets.js"

const DATABASE_URL = "DATABASE_URL"

/** Upsert options that write `DATABASE_URL` as the CLI's. */
export const CLI_DATABASE_URL = { managed: [DATABASE_URL] } as const

/** True when `.env`'s DATABASE_URL is the CLI's: marked, or unmarked in the shape it writes. */
export function cliWroteDatabaseUrl(cwd: string): boolean {
  const owner = envValueOwner(cwd, DATABASE_URL)
  if (owner === null) return false
  return owner === "cli" || hasInitShape(readEnvFile(cwd))
}

/** The URL `init` or Docker dev wrote before the marker: their user, password and database, locally. */
function hasInitShape(env: Readonly<Record<string, string>>): boolean {
  const value = env[DATABASE_URL] ?? ""
  const password = env["POSTGRES_PASSWORD"] ?? ""
  if (password === "" || !isLocalDatabaseUrl(value)) return false
  const url = new URL(value)
  return (
    decodeURIComponent(url.username) === (env["POSTGRES_USER"] || BUNDLED_DB_USER) &&
    decodeURIComponent(url.password) === password &&
    url.pathname.replace(/^\//, "") === (env["POSTGRES_DB"] || "supatype")
  )
}

/**
 * Native dev's half: a CLI-written URL is moved to the native database and said to be; a
 * hand-written one is kept, with a warning when nothing answers where it points, since every
 * host command will use it.
 */
export async function reconcileNativeDatabaseUrl(cwd: string, nativeDsn: string): Promise<void> {
  const outcome = adoptNativeDatabaseUrl(cwd, nativeDsn)
  if (outcome === "adopted") {
    console.log("[supatype] DATABASE_URL in .env now names this project's native database; the CLI had written it for Docker.")
    return
  }
  if (outcome !== "hand-written") return
  const where = databaseHostPort(readEnvFile(cwd)[DATABASE_URL] ?? "")
  if (where === undefined || (await connectSucceeds(where.port, 1_000, where.host))) return
  console.warn(
    `[supatype] ⚠  DATABASE_URL in .env, which you wrote, names ${where.host}:${where.port}, and nothing answers ` +
      "there. Host commands (push, seed, admin) use it as written; remove it to use this project's database.",
  )
}

/** The host and port a Postgres URL names, the port defaulting to 5432; undefined when it does not parse. */
function databaseHostPort(value: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(value)
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port === "" ? DEFAULT_DB_PORT : Number(url.port) }
  } catch {
    return undefined
  }
}

/**
 * Point a CLI-written `.env` DATABASE_URL at the native database, marked as the CLI's, so host
 * commands run from any shell reach it. A hand-written URL is left as it is: it always wins.
 */
export function adoptNativeDatabaseUrl(cwd: string, nativeDsn: string): "adopted" | "hand-written" | "unchanged" {
  if (envValueOwner(cwd, DATABASE_URL) === null) return "unchanged"
  if (!cliWroteDatabaseUrl(cwd)) return "hand-written"
  if (readEnvFile(cwd)[DATABASE_URL] === nativeDsn) return "unchanged"
  upsertEnvFile(cwd, { [DATABASE_URL]: nativeDsn }, CLI_DATABASE_URL)
  return "adopted"
}
