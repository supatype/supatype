/**
 * Whether a database a command was pointed at is this project's own local one, and where that
 * project's running stack answers.
 *
 * `push --connection` used to provision storage against `http://localhost:18473` with a key signed
 * by the published dev secret, and to print a Studio link there, whatever the target was. 18473 is
 * only the default gateway port, so on a machine running another project it reached that project's
 * stack (A3-N4, A4-N2). It also wrote row-cache settings into `.env` and told the person to
 * recreate a database container that did not exist (A2-N4, T2-N11).
 */

import { readComposeEnvInt } from "./env-file.js"
import { composeDbHostPort } from "./host-database.js"
import { composeRenderMode } from "./compose-render-mode.js"
import { devDatabaseIdentity, isDevDatabaseUrl } from "./local-secrets.js"
import { portHeldByComposeProject } from "./dev-ports.js"
import { composeProjectName } from "./self-host-compose.js"
import {
  connectionString,
  resolveRuntimeProvider,
  serverBaseUrl,
  usesExternalDatabase,
  type SupatypeProjectConfig,
} from "./project-config.js"

/**
 * True when `databaseUrl` is the database this project runs for itself: the docker project's
 * published compose database, or a native project's own. Undefined means "the project's own", as
 * a command given no connection uses it. Never for an external database.
 */
export function isProjectDatabase(
  cwd: string,
  config: SupatypeProjectConfig,
  databaseUrl: string | undefined,
): boolean {
  if (usesExternalDatabase(config)) return false
  if (databaseUrl === undefined) return true
  if (resolveRuntimeProvider(config) !== "docker") return sameDatabase(databaseUrl, connectionString(config, undefined, cwd))
  const port = composeDbHostPort(cwd, composeRenderMode(cwd, config.project.name))
  return isDevDatabaseUrl(databaseUrl, devDatabaseIdentity(cwd), { port })
}

/**
 * The project's own running stack's API address, when `databaseUrl` is its database and the stack
 * is up; otherwise undefined, and nothing should be sent to any local gateway.
 *
 * For docker, the gateway on the project's Kong port, and only when that port is published by this
 * project's compose stack: a gateway on the same port belonging to anything else is not ours.
 */
export function projectStackUrl(
  cwd: string,
  config: SupatypeProjectConfig,
  databaseUrl: string | undefined,
): string | undefined {
  if (!isProjectDatabase(cwd, config, databaseUrl)) return undefined
  if (resolveRuntimeProvider(config) !== "docker") return serverBaseUrl(config, cwd)?.replace(/\/$/, "")
  const kongPort = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT")
  if (kongPort === null) return undefined
  if (!portHeldByComposeProject(kongPort, composeProjectName(config.project.name))) return undefined
  return `http://localhost:${kongPort}`
}

/** Studio under a stack's API address: it is served at `/studio/` behind the gateway. */
export function studioUrlAt(apiUrl: string): string {
  return `${apiUrl.replace(/\/$/, "")}/studio/`
}

/** Studio on the project's own running stack, when `databaseUrl` is its database (see {@link projectStackUrl}). */
export function projectStudioUrl(
  cwd: string,
  config: SupatypeProjectConfig,
  databaseUrl: string | undefined,
): string | undefined {
  const stackUrl = projectStackUrl(cwd, config, databaseUrl)
  return stackUrl === undefined ? undefined : studioUrlAt(stackUrl)
}

function sameDatabase(a: string, b: string): boolean {
  const x = parse(a)
  const y = parse(b)
  if (x === null || y === null) return a === b
  return x.hostname === y.hostname && x.port === y.port && x.pathname === y.pathname && x.username === y.username
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
