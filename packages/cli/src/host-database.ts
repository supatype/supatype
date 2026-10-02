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
import { readEnvFile, readEnvValue } from "./env-file.js"
import { devPostgresPassword } from "./local-secrets.js"
import {
  externalDatabaseUrl,
  localDSN,
  projectRootFromConfig,
  resolveRuntimeProvider,
  type SupatypeProjectConfig,
} from "./project-config.js"

/** Where `supatype dev` publishes a docker project's Postgres when `.env` does not say. */
export const COMPOSE_DEV_DB_PORT = 54329

/**
 * A docker project's own Postgres, as reached from the host: the port `supatype dev` publishes it
 * on, with the credentials and database the stack was created with, all read from `.env`.
 */
export function hostComposeDbUrl(cwd: string): string {
  const port = readEnvValue(cwd, "SUPATYPE_DEV_DB_PORT", String(COMPOSE_DEV_DB_PORT))
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  return `postgresql://${user}:${devPostgresPassword(cwd)}@127.0.0.1:${port}/${db}?sslmode=disable`
}

/**
 * The database Supatype runs for this project, when nothing names one.
 *
 * For docker, the published compose database. It used to be `localDSN` for every provider,
 * `postgres:postgres@127.0.0.1:5432/<project name>`, which is the native layout: a docker
 * project with no `.env` got a user, database and port that do not exist.
 */
function derivedDsn(root: string, config: SupatypeProjectConfig): string {
  return resolveRuntimeProvider(config) === "docker" ? hostComposeDbUrl(root) : localDSN(config)
}

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
  const fileValue = candidate(
    fileLabel,
    fromFile["DATABASE_URL"],
    existsSync(envPath) ? "the file has no DATABASE_URL" : "no .env file",
  )
  if (fileValue !== undefined) return { dsn: fileValue, source: fileLabel, tried }

  if (options.allowDerived === true) {
    const derived = derivedDsn(root, config)
    tried.push({ name: "the project's own local database", detail: redact(derived), found: true })
    return { dsn: derived, source: "the project's own local database", tried }
  }
  tried.push({
    name: "the project's own local database",
    detail: "this project points at a database it does not manage, so there is no default",
    found: false,
  })

  throw new DsnNotFound(tried)
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
