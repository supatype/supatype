/**
 * Role fixes applied inside the project's `db` container on every start, as the bundled superuser.
 */

import { dirname } from "node:path"
import { askDockerSync, DOCKER_EXEC_TIMEOUT_MS, type DockerAnswer } from "./docker-exec.js"
import { spawnFailureText } from "./error-message.js"
import {
  SQL_EDITOR_PASSWORD_ENV,
  devAuthenticatorPassword,
  devDatabaseIdentity,
  devSqlEditorPassword,
} from "./local-secrets.js"
import type { SelfHostComposePaths } from "./self-host-compose.js"
import { degraded } from "./strict.js"
import { dockerEnv } from "./docker-env.js"
import { PRIVATE_TABLE_DEFAULTS_SQL } from "./native-roles-sql.js"

type ComposeTarget = Pick<SelfHostComposePaths, "composePath">

const RECONCILE_AUTHENTICATOR_SQL = [
  "\\getenv pw SUPATYPE_AUTHENTICATOR_PASSWORD",
  "ALTER ROLE authenticator WITH LOGIN PASSWORD :'pw';",
  "",
].join("\n")

// `\gexec` rather than a DO block: psql does not interpolate `:'pw'` inside a dollar-quoted body.
// The WHERE clause yields no statement at all on a volume whose image predates the role.
const RECONCILE_SQL_EDITOR_SQL = [
  `\\getenv pw ${SQL_EDITOR_PASSWORD_ENV}`,
  "SELECT format('ALTER ROLE supatype_sql_editor WITH LOGIN PASSWORD %L', :'pw')",
  "WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'supatype_sql_editor')",
  "\\gexec",
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
 * The password and `env` reach the container as bare `-e NAME` flags with the values in docker's
 * own environment, so a script can read a secret with `\getenv` and neither it nor the password is
 * on docker's command line, where any local user could read it from the process list.
 */
function runOwnerPsql(
  paths: ComposeTarget,
  cwd: string,
  composeProject: string,
  sql: string,
  env: Record<string, string> = {},
): DockerAnswer {
  const { user, password, database } = devDatabaseIdentity(cwd)
  const secrets = dockerEnv({ PGPASSWORD: password, ...env })
  return askDockerSync(
    [
      "compose", "-p", composeProject, "-f", paths.composePath,
      "exec", "-T", ...secrets.args,
      "db", "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database,
    ],
    { cwd: dirname(paths.composePath), timeoutMs: DOCKER_EXEC_TIMEOUT_MS, input: sql, env: secrets.env },
  )
}

/** Why a `docker` call failed, from whatever it said. */
function failureDetail(result: DockerAnswer): string {
  return spawnFailureText({ ...result, stdout: "" })
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
 * Set `supatype_sql_editor`'s password to the one `.env` holds, every time the stack starts.
 *
 * The image passwords that role once, at bootstrap, so the same drift as
 * {@link reconcileAuthenticatorPassword} applies: a `.env` that moved after the volume was made
 * leaves Studio's SQL editor unable to log in. Skipped when the role does not exist yet.
 */
export function reconcileSqlEditorPassword(
  paths: ComposeTarget,
  cwd: string,
  composeProject: string,
): void {
  const result = runOwnerPsql(paths, cwd, composeProject, RECONCILE_SQL_EDITOR_SQL, {
    [SQL_EDITOR_PASSWORD_ENV]: devSqlEditorPassword(cwd),
  })
  if (result.status !== 0) {
    degraded(
      "Could not set the SQL editor password, so Studio's SQL editor cannot connect",
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

/**
 * Give tables in `public` to `service_role` only by default (CL-N2). The Postgres image grants
 * every privilege on new tables to `anon` and `authenticated`, so a table made by hand in dev was
 * open to anyone holding the anon key; a model table's grants come from the engine instead.
 * Idempotent, and run on every start, so a database created before this changes too.
 */
export function privatizeTableDefaults(paths: ComposeTarget, cwd: string, composeProject: string): void {
  const result = runOwnerPsql(paths, cwd, composeProject, PRIVATE_TABLE_DEFAULTS_SQL)
  if (result.status !== 0) {
    degraded(
      "Could not take anon and authenticated out of the default table privileges, so a table made by hand is readable with the anon key",
      failureDetail(result),
    )
  }
}
