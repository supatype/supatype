/**
 * Role fixes applied inside the project's `db` container on every start, as the bundled superuser.
 */

import { dirname } from "node:path"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { devAuthenticatorPassword, devDatabaseIdentity } from "./local-secrets.js"
import type { SelfHostComposePaths } from "./self-host-compose.js"
import { degraded } from "./strict.js"

type ComposeTarget = Pick<SelfHostComposePaths, "composePath">

const RECONCILE_AUTHENTICATOR_SQL = [
  "\\getenv pw SUPATYPE_AUTHENTICATOR_PASSWORD",
  "ALTER ROLE authenticator WITH LOGIN PASSWORD :'pw';",
  "",
].join("\n")

const GRANT_AUTH_SCHEMA_SQL = [
  "GRANT USAGE ON SCHEMA auth TO service_role;",
  "GRANT SELECT ON auth.users TO service_role;",
  "",
].join("\n")

/**
 * Run `sql` through `psql` in the `db` container, as the bundled superuser, against the project's
 * database.
 *
 * `env` is passed into the container rather than onto the command line, so a script can read a
 * secret with `\getenv` and it never appears in a process listing.
 */
function runOwnerPsql(
  paths: ComposeTarget,
  cwd: string,
  composeProject: string,
  sql: string,
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const { user, password, database } = devDatabaseIdentity(cwd)
  const envArgs = Object.entries({ PGPASSWORD: password, ...env })
    .flatMap(([key, value]) => ["-e", `${key}=${value}`])
  return spawnSync(
    "docker",
    [
      "compose", "-p", composeProject, "-f", paths.composePath,
      "exec", "-T", ...envArgs,
      "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database,
    ],
    { cwd: dirname(paths.composePath), encoding: "utf8", timeout: 10_000, input: sql },
  )
}

/** Why a `docker` call failed, from whatever it said. */
function failureDetail(result: SpawnSyncReturns<string>): string {
  const detail = [result.stderr, result.error?.message]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join("\n")
  return detail === "" ? "docker gave no output." : detail
}

/**
 * Set `authenticator`'s password to the one `.env` holds, every time the stack starts.
 *
 * The Postgres image passwords that role from `AUTHENTICATOR_PASSWORD` in its init scripts, which
 * run once, on an empty data directory. So the value the role actually has is whatever `.env` said
 * the day the volume was created, and `.env` can move afterwards. When the two diverge PostgREST
 * cannot log in, exits, and every REST request answers 502 with the real reason visible only in a
 * container log the developer has no reason to read.
 *
 * Reconciling here makes `.env` the answer to what the password is, rather than the volume's
 * birthday. It is idempotent, and it runs before the schema push so the API is already reachable by
 * the time the stack reports ready.
 */
export function reconcileAuthenticatorPassword(
  paths: ComposeTarget,
  cwd: string,
  composeProject: string,
): void {
  const result = runOwnerPsql(paths, cwd, composeProject, RECONCILE_AUTHENTICATOR_SQL, {
    SUPATYPE_AUTHENTICATOR_PASSWORD: devAuthenticatorPassword(cwd),
  })
  if (result.status !== 0) {
    degraded(
      "Could not set the authenticator password, so the REST API will answer 502",
      failureDetail(result),
    )
  }
}

/**
 * Let `service_role` read `auth.users`, which Studio's relation preview resolves a user relation
 * through.
 */
export function grantAuthSchemaAccess(
  paths: ComposeTarget,
  cwd: string,
  composeProject: string,
): void {
  const result = runOwnerPsql(paths, cwd, composeProject, GRANT_AUTH_SCHEMA_SQL)
  if (result.status !== 0) {
    degraded(
      "Could not grant service_role access to auth.users, so Studio's relation preview cannot read users",
      failureDetail(result),
    )
  }
}
