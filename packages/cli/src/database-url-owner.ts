/**
 * Whose `.env` `DATABASE_URL` is, and the one writer of it.
 *
 * `init` writes a URL for the Docker stack, and every host command reads `.env`'s URL ahead of the
 * project's own database. A project made for Docker and then run native therefore sent `push`,
 * `seed` and `admin` to the Docker database, where nothing listened (local test N1). Nothing could
 * tell that URL from one a person wrote to reach their own Postgres, which must always win.
 *
 * So there is one rule, read from `.env` once:
 *
 * - none: `.env` names no URL.
 * - cli: the URL carries the CLI's label ({@link DATABASE_URL_MARKER}, or an older managed marker),
 *   or is exactly the URL the CLI writes, from a `.env` older than the label: the bundled user,
 *   POSTGRES_PASSWORD, POSTGRES_DB and a host on this machine, on any port. It belongs to whichever
 *   provider and port the project runs: every writer may rewrite it, and host commands use the
 *   database the project runs in its place (host-database.ts).
 * - you: anything else. Never changed, by any command, with a warning when nothing answers there.
 *
 * Every write of the URL, by `init`, Docker dev, native dev, a port saved from the shell or a
 * self-host stack started, goes through {@link writeCliDatabaseUrl}, which applies the rule.
 */
import { DATABASE_URL_MARKER, readEnvSnapshot, shellEnvInt, upsertEnvFile } from "./env-file.js"
import { composeDbPublish, databaseUrlHostPort, databaseUrlWithPort, DEV_DB_PORT_ENV, publishedDbPort, type DbPortSync } from "./db-port.js"
import { setForThisRunOnly, setInShell } from "./shell-ports.js"
import { connectSucceeds } from "./postgres-ctl.js"
import { devDatabaseIdentityOf, isDevDatabaseUrl } from "./local-secrets.js"

const DATABASE_URL = "DATABASE_URL"

/** Whose `.env` DATABASE_URL is: see the module comment. */
export type DatabaseUrlOwner = "none" | "cli" | "you"

/** `.env`'s DATABASE_URL and whose it is, from one read of the file. */
export interface DatabaseUrlState {
  owner: DatabaseUrlOwner
  /** The URL, trimmed; undefined when `.env` names none. */
  url: string | undefined
  /** Every `.env` value from the same read, for a caller that needs more than the URL. */
  env: Readonly<Record<string, string>>
}

/** `.env`'s DATABASE_URL and whose it is. */
export function databaseUrlState(cwd: string): DatabaseUrlState {
  const { values, managed } = readEnvSnapshot(cwd)
  const url = values[DATABASE_URL]?.trim()
  if (url === undefined || url === "") return { owner: "none", url: undefined, env: values }
  const cli = managed.has(DATABASE_URL) || isDevDatabaseUrl(url, devDatabaseIdentityOf(values), { credentials: true })
  return { owner: cli ? "cli" : "you", url, env: values }
}

/** Whose `.env` DATABASE_URL is. */
export function databaseUrlOwner(cwd: string): DatabaseUrlOwner {
  return databaseUrlState(cwd).owner
}

/** The lines holding a URL the CLI owns, exactly as {@link writeCliDatabaseUrl} writes them, for `init`'s template. */
export function cliDatabaseUrlLines(url: string): string {
  return `${DATABASE_URL_MARKER}\n${DATABASE_URL}=${url}`
}

/** What {@link writeCliDatabaseUrl} did with the URL. */
export type CliDatabaseUrlWrite = "written" | "unchanged" | "yours"

/**
 * Write `url` as `.env`'s DATABASE_URL, labelled as the CLI's, with `alongside` in the same pass,
 * unless the URL there is yours: then only `alongside` is written. `state` is the caller's read of
 * `.env`, when it has one.
 */
export function writeCliDatabaseUrl(
  cwd: string,
  url: string,
  alongside: Record<string, string> = {},
  state: DatabaseUrlState = databaseUrlState(cwd),
): CliDatabaseUrlWrite {
  if (state.owner === "you") {
    if (Object.keys(alongside).length > 0) upsertEnvFile(cwd, alongside)
    return "yours"
  }
  upsertEnvFile(cwd, { ...alongside, [DATABASE_URL]: url }, { managed: [DATABASE_URL], label: DATABASE_URL_MARKER })
  return state.url === url ? "unchanged" : "written"
}

/**
 * The URL for this run only, when the port it names came from the shell (DR9): set in this
 * process's environment, which compose, seeds and the CLI's own connections read ahead of `.env`.
 * Not over a URL that is yours, nor one the shell sets. True when it was set.
 */
export function setCliDatabaseUrlForRun(state: DatabaseUrlState, url: string, shell: NodeJS.ProcessEnv = process.env): boolean {
  if (state.owner === "you" || setInShell(shell, DATABASE_URL)) return false
  shell[DATABASE_URL] = url
  return true
}

/**
 * Point a CLI-owned DATABASE_URL at the port the stack's layout publishes Postgres on, for a dev
 * stack (`devLocal`) or a self-host one: in `.env`, or for a port only the shell gives, in this
 * run's environment. What moved, for the caller to report, or null.
 *
 * `devLocal` is the layout of the stack the caller works with, never a guess from which variables
 * `.env` holds: a project that once ran dev keeps SUPATYPE_DEV_DB_PORT there, and preferring it on a
 * self-host push repointed every host command at the dev database. Only a URL on this machine
 * moves; one naming a database elsewhere has a port that is nothing to do with the compose mapping.
 */
export function syncDatabaseUrlPort(cwd: string, devLocal: boolean, shell: NodeJS.ProcessEnv = process.env): DbPortSync | null {
  const state = databaseUrlState(cwd)
  if (state.owner !== "cli") return null
  const { envKey } = composeDbPublish(devLocal)
  const moved = databaseUrlWithPort(state.url, shellEnvInt(envKey, shell) ?? publishedDbPort(state.env, devLocal))
  if (moved === null) return null
  const sync: DbPortSync = { from: moved.from, to: moved.to, envKey }
  if (!setForThisRunOnly(shell, state.env, envKey) || shellEnvInt(envKey, shell) === null) {
    writeCliDatabaseUrl(cwd, moved.url, {}, state)
    return sync
  }
  return setCliDatabaseUrlForRun(state, moved.url, shell) ? { ...sync, runOnly: true } : null
}

/**
 * Native dev's half: a CLI-owned URL is moved to the native database and said to be; one that is
 * yours is kept, with a warning when nothing answers where it points, since every host command
 * will use it.
 */
export async function reconcileNativeDatabaseUrl(
  cwd: string,
  nativeDsn: string,
  shell: NodeJS.ProcessEnv = process.env,
  state: DatabaseUrlState = databaseUrlState(cwd),
): Promise<void> {
  if (state.owner === "you") return warnIfHandWrittenUrlSilent(cwd, state)
  if (state.owner !== "cli") return
  // A port only the shell gives is this run's (DR9): the URL follows it for this run, not in `.env`.
  if (setForThisRunOnly(shell, state.env, DEV_DB_PORT_ENV)) {
    setCliDatabaseUrlForRun(state, nativeDsn, shell)
    return
  }
  if (writeCliDatabaseUrl(cwd, nativeDsn, {}, state) === "written") {
    console.log("[supatype] DATABASE_URL in .env now names this project's native database; the CLI had written it for Docker.")
  }
}

/**
 * Warn, naming host and port but never the password, when `.env` holds a DATABASE_URL that is
 * yours and nothing answers where it points: every host command (push, seed, admin) will use it.
 */
export async function warnIfHandWrittenUrlSilent(cwd: string, state: DatabaseUrlState = databaseUrlState(cwd)): Promise<void> {
  if (state.owner !== "you") return
  const where = databaseUrlHostPort(state.url)
  if (where === undefined || (await connectSucceeds(where.port, 1_000, where.host))) return
  console.warn(
    `[supatype] ⚠  DATABASE_URL in .env, which you wrote, names ${where.host}:${where.port}, and nothing answers ` +
      "there. Host commands (push, seed, admin) use it as written; remove it to use this project's database.",
  )
}
