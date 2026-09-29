/**
 * Which database a seed run targets, and how that was decided.
 *
 * Its own file so the failure is testable without spawning anything. The failure is the
 * point: the old seed template carried a hardcoded fallback DSN, so a project with no
 * `.env` did not fail, it silently tried `localhost:5432` with a guessed password and
 * reported a connection error that named none of the things it had looked at. Someone
 * reading that has no way to tell "I have not set DATABASE_URL" from "the stack is not
 * running".
 *
 * So every source is recorded whether it was found or not, and the error prints the lot.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { readEnvFile } from "./env-file.js"
import {
  externalDatabaseUrl,
  localDSN,
  projectRootFromConfig,
  type SupatypeProjectConfig,
} from "./project-config.js"

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
      `No database connection string for this seed run.\n${tried
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
export function resolveSeedDsn(
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
    const derived = localDSN(config)
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
