/**
 * Password authentication for the native Postgres `supatype dev` runs.
 *
 * Clusters used to be initialised with `--auth trust`, so the passwords the CLI generates were
 * never checked: any local process could connect as any role, the superuser included, with any
 * password or none. New clusters are initialised with scram-sha-256 (postgres-ctl `initdb`).
 * A cluster made before that is converted the first time `dev` or `supatype pg start` starts it:
 * the superuser is given the project's password while trust still lets the CLI in, and then
 * pg_hba.conf stops trusting anyone.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NATIVE_AUTH_METHOD, pgBin, pgSpawnEnv, reload, type PgOptions } from "./postgres-ctl.js"

const SUPERUSER_PASSWORD_ENV = "SUPATYPE_SUPERUSER_PASSWORD"

/**
 * pg_hba.conf with every entry that grants `trust` switched to scram-sha-256, or null when none
 * does. Comments and every other entry are kept as they are.
 */
export function hbaWithoutTrust(text: string): string | null {
  let changed = false
  const lines = text.split("\n").map((line) => {
    if (line.trimStart().startsWith("#")) return line
    const rewritten = line.replace(/(\s)trust(\s*)$/, `$1${NATIVE_AUTH_METHOD}$2`)
    if (rewritten !== line) changed = true
    return rewritten
  })
  return changed ? lines.join("\n") : null
}

/** True when the cluster's pg_hba.conf lets any connection in without a password. */
export function clusterGrantsTrust(dataDir: string): boolean {
  const hba = join(dataDir, "pg_hba.conf")
  return existsSync(hba) && hbaWithoutTrust(readFileSync(hba, "utf8")) !== null
}

/** The environment for a client of the native cluster, as `user` with `password`. */
export function pgClientEnv(pgBinDir: string, password: string): NodeJS.ProcessEnv {
  return { ...pgSpawnEnv(pgBinDir), PGPASSWORD: password }
}

/**
 * Make a running cluster check passwords, if it does not yet. Returns true when it converted one.
 *
 * The superuser gets `superuserPassword` first, through the trust that is about to go, so the
 * CLI can still connect afterwards. Then pg_hba.conf is rewritten and the server reloads it.
 */
export function requirePasswordAuth(opts: PgOptions, superuserPassword: string): boolean {
  if (!clusterGrantsTrust(opts.dataDir)) return false
  setSuperuserPassword(opts, superuserPassword)
  const hbaPath = join(opts.dataDir, "pg_hba.conf")
  writeFileSync(hbaPath, hbaWithoutTrust(readFileSync(hbaPath, "utf8")) ?? "", "utf8")
  reload(opts)
  return true
}

function setSuperuserPassword(opts: PgOptions, password: string): void {
  // Through psql's environment, never its arguments, so the password is not on a command line.
  const sql = `\\getenv pw ${SUPERUSER_PASSWORD_ENV}\nALTER ROLE postgres PASSWORD :'pw';\n`
  const result = spawnSync(
    pgBin(opts.pgBinDir, "psql"),
    ["-h", "127.0.0.1", "-p", String(opts.port), "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    {
      input: sql,
      encoding: "utf8",
      env: { ...pgSpawnEnv(opts.pgBinDir), [SUPERUSER_PASSWORD_ENV]: password },
    },
  )
  if (result.status !== 0) {
    throw new Error(`Could not set the superuser's password: ${(result.stderr ?? "").trim()}`)
  }
}
