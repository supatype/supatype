/**
 * The `docker compose exec` command line for `psql` in a stack's `db` container.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { dockerEnv, type DockerEnv } from "./docker-env.js"
import { devDatabaseIdentity } from "./local-secrets.js"

/** Which stack: its compose project and compose file. */
export interface ComposeStack {
  project: string
  composePath: string
}

/**
 * Arguments and environment to run `psql ...psqlArgs` in `stack`'s `db` container, logged in as
 * the project's database owner, against the project's database.
 *
 * The password is a bare `-e PGPASSWORD` with its value in the returned environment, so it is
 * not on docker's command line. Spawn docker with `env`.
 */
export function composeDbPsql(cwd: string, stack: ComposeStack, psqlArgs: string[]): DockerEnv {
  const { user, password, database } = devDatabaseIdentity(cwd)
  const secrets = dockerEnv({ PGPASSWORD: password })
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "-p", stack.project, "--project-directory", cwd, "-f", stack.composePath]
  if (existsSync(envFile)) args.push("--env-file", envFile)
  args.push("exec", "-T", ...secrets.args, "db", "psql", "-U", user, "-d", database, ...psqlArgs)
  return { args, env: secrets.env }
}
