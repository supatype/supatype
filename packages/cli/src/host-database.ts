/**
 * Which database a command run on the host connects to, and how that was decided.
 *
 * One resolver for every host-side command: seed, adopt, introspect, migrate, doctor, pull, and
 * any target resolved in direct mode. They used to find the database three different ways, and
 * the one most of them used took `.supatype/environment.json`'s URL, which describes the docker
 * `db` *container*, so `supatype adopt` on a docker project failed looking up the host `db`
 * (supatype#85). Another read `process.env` and never the project's `.env`, where `supatype dev`
 * writes the host-published URL. Seed's order was the one that worked, so it is this one.
 *
 * Its own file so the failure is testable without spawning anything. The failure is the point: a
 * hardcoded fallback DSN meant a project with no `.env` silently tried `localhost:5432` with a
 * guessed password and reported a connection error that named none of the things it had looked
 * at. So every source is recorded whether it was found or not, and the error prints the lot.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { runningStackMode, type ComposeRenderMode } from "./compose-render-mode.js"
import { composeDbPublish } from "./db-port.js"
import { readComposeEnvInt, readEnvFile } from "./env-file.js"
import { devDatabaseUrl, devPostgresPassword } from "./local-secrets.js"
import { cliWroteDatabaseUrl } from "./database-url-owner.js"
import {
  externalDatabaseUrl,
  localDSN,
  projectRootFromConfig,
  resolveRuntimeProvider,
  type SupatypeProjectConfig,
} from "./project-config.js"

export { COMPOSE_DEV_DB_PORT } from "./db-port.js"

/**
 * The host port a docker project's Postgres is published on in the stack's layout: the variable
 * the compose file binds for that layout (exported first, then `.env`, as compose reads it), or
 * the port it binds when the variable is unset. Read through {@link composeDbPublish}, the same
 * definition the compose template is written from.
 */
export function composeDbHostPort(cwd: string, mode: ComposeRenderMode): number {
  const { envKey, defaultPort } = composeDbPublish(mode === "dev")
  return readComposeEnvInt(cwd, envKey) ?? defaultPort
}

/**
 * A docker project's own Postgres at host port `port`, with the credentials and database the
 * stack was created with, read from `.env`.
 *
 * IPv4 because a dev stack publishes the port on `127.0.0.1` only, and `localhost` can resolve to
 * `::1` first.
 */
export function hostComposeDbUrl(cwd: string, port: number | string): string {
  return devDatabaseUrl(cwd, `127.0.0.1:${port}`)
}

/** No stack runs for the project, so there is no stack database to derive. */
export class NoStackRunning extends Error {
  constructor(readonly projectName: string) {
    super(
      `No stack is running for ${projectName}. Start it with \`supatype dev\` or \`supatype self-host compose up -d\`.`,
    )
    this.name = "NoStackRunning"
  }
}

/**
 * The layout of the project's running stack ({@link runningStackMode}), or {@link NoStackRunning}
 * when none runs. Guessing a layout then (production, port 5432) reached whatever Postgres the host
 * had there, which need not be this project's (M1b).
 */
export function requireRunningStack(cwd: string, projectName: string): ComposeRenderMode {
  const mode = runningStackMode(cwd, projectName)
  if (mode === undefined) throw new NoStackRunning(projectName)
  return mode
}

/**
 * The project's stack database as reached from the host, at the port its layout publishes.
 *
 * The layout is the running stack's own: dev while a `supatype dev` session holds it or its server
 * runs in dev mode, otherwise production. Host-side commands used to read the dev port whatever the
 * stack was (M1), so on a production stack they reached 54329, where nothing listened or another
 * project's dev database did. With no stack running it refuses ({@link requireRunningStack}).
 */
export function stackHostDbUrl(cwd: string, projectName: string): string {
  return hostComposeDbUrl(cwd, composeDbHostPort(cwd, requireRunningStack(cwd, projectName)))
}

/**
 * The database Supatype runs for this project, when nothing names one.
 *
 * For docker, the published compose database. It used to be `localDSN` for every provider,
 * `postgres:postgres@127.0.0.1:5432/<project name>`, which is the native layout: a docker
 * project with no `.env` got a user, database and port that do not exist.
 */
function derivedDsn(root: string, config: SupatypeProjectConfig): string {
  return resolveRuntimeProvider(config) === "docker"
    ? stackHostDbUrl(root, config.project.name)
    : localDSN(config, devPostgresPassword(root), root)
}

/** The `source` of a {@link ResolvedDsn} derived from the project's own stack, not named by anyone. */
export const DERIVED_DSN_SOURCE = "the project's own local database"

/** One place a connection string could have come from. */
export interface DsnSource {
  /** How it would be described to the person running the command. */
  name: string
  /** What was found there, or why nothing was. */
  detail: string
  found: boolean
}

export interface ResolvedDsn {
  dsn: string
  /** The `name` of the source it came from. */
  source: string
  /** Every source, in the order they were considered. */
  tried: readonly DsnSource[]
}

/** Nothing named a database, with every source tried. */
export class DsnNotFound extends Error {
  constructor(readonly tried: readonly DsnSource[]) {
    super(
      `No database connection string to connect with.\n${tried
        .map((source) => `  ${source.found ? "found" : "not set"}  ${source.name}: ${source.detail}`)
        .join("\n")}`,
    )
    this.name = "DsnNotFound"
  }
}

export interface ResolveOptions {
  /** `--connection`, which beats everything because it was typed just now. */
  connection?: string | undefined
  /**
   * Whether to fall back to the DSN derived from the project name.
   *
   * True for a project whose database Supatype manages, where the derived value is right by
   * construction. A project pointed at someone else's Postgres has no such default, and
   * inventing one would send the seed to a database nobody named.
   */
  allowDerived?: boolean
}

/**
 * Resolve the DSN, in the order the rest of the CLI already uses.
 *
 * `.env` is loaded first but ranks below a real environment variable, which is how every
 * other dotenv reader behaves and how Compose resolves the same names.
 */
export function resolveHostDatabaseUrl(
  cwd: string,
  config: SupatypeProjectConfig,
  options: ResolveOptions = {},
): ResolvedDsn {
  const root = projectRootFromConfig(config, cwd)
  const envPath = join(root, ".env")
  const fromFile = readEnvFile(root)
  const tried: DsnSource[] = []

  const candidate = (name: string, value: string | undefined, absent: string): string | undefined => {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed.length > 0) {
      tried.push({ name, detail: redact(trimmed), found: true })
      return trimmed
    }
    tried.push({ name, detail: absent, found: false })
    return undefined
  }

  const flag = candidate("--connection", options.connection, "not passed")
  if (flag !== undefined) return { dsn: flag, source: "--connection", tried }

  // Ahead of the rest on purpose: a stated external database is the whole stack's database,
  // and seeding somewhere else while the services read from here would look like data loss.
  const external = candidate(
    "database.external.url in supatype.config.ts",
    externalDatabaseUrl(config),
    "not declared",
  )
  if (external !== undefined) {
    return { dsn: external, source: "database.external.url in supatype.config.ts", tried }
  }

  const declared = candidate("connection in supatype.config.ts", config.connection, "not declared")
  if (declared !== undefined) {
    return { dsn: declared, source: "connection in supatype.config.ts", tried }
  }

  const fromEnv = candidate("DATABASE_URL in the environment", process.env["DATABASE_URL"], "not set")
  if (fromEnv !== undefined) {
    return { dsn: fromEnv, source: "DATABASE_URL in the environment", tried }
  }

  const fileLabel = `DATABASE_URL in ${envPath}`
  const fromEnvFile = envFileDatabaseUrl(root, config, options, fromFile["DATABASE_URL"])
  const fileValue = candidate(fileLabel, fromEnvFile, existsSync(envPath) ? fileUrlAbsence(fromFile) : "no .env file")
  if (fileValue !== undefined) return { dsn: fileValue, source: fileLabel, tried }

  if (options.allowDerived === true) {
    const derived = derivedDsn(root, config)
    tried.push({ name: DERIVED_DSN_SOURCE, detail: redact(derived), found: true })
    return { dsn: derived, source: DERIVED_DSN_SOURCE, tried }
  }
  tried.push({
    name: DERIVED_DSN_SOURCE,
    detail: "this project points at a database it does not manage, so there is no default",
    found: false,
  })

  throw new DsnNotFound(tried)
}

/**
 * `.env`'s DATABASE_URL as this project should use it. A URL the CLI wrote belongs to the provider
 * the project runs, so a native project that may fall back to its own database passes over one
 * written for Docker (local test N1: `init` writes the Docker URL, and `push` after switching to
 * native went to it). A hand-written URL is always used as written (database-url-owner.ts).
 */
function envFileDatabaseUrl(
  root: string,
  config: SupatypeProjectConfig,
  options: ResolveOptions,
  value: string | undefined,
): string | undefined {
  if (value === undefined || options.allowDerived !== true) return value
  if (resolveRuntimeProvider(config) !== "native" || !cliWroteDatabaseUrl(root)) return value
  return value.trim() === derivedDsn(root, config) ? value : undefined
}

/** Why `.env` gave no DATABASE_URL, when the file exists. */
function fileUrlAbsence(fromFile: Readonly<Record<string, string>>): string {
  return fromFile["DATABASE_URL"] === undefined
    ? "the file has no DATABASE_URL"
    : "written by the CLI for the Docker stack, and this project runs native"
}

/**
 * A connection string with its password removed.
 *
 * Every one of these reaches a terminal, and often a CI log. Printing a DSN to explain where
 * it came from should not be how a password ends up somewhere it is kept.
 */
export function redact(dsn: string): string {
  return dsn.replace(/(:\/\/[^:/@]+:)[^@]*(@)/, "$1***$2")
}

/**
 * A connection string without its password, and the password, for a child process: the
 * password goes in its `PGPASSWORD`, where the process list does not show it, and the rest on
 * its command line.
 */
export function splitPassword(dsn: string): { dsn: string; password: string | undefined } {
  const match = /(:\/\/[^:/@]+):([^@]*)@/.exec(dsn)
  if (!match) return { dsn, password: undefined }
  return { dsn: dsn.replace(match[0], `${match[1]}@`), password: decodeURIComponent(match[2]!) }
}
