/**
 * The secrets the local stack runs with.
 *
 * **Read from `.env`, never pinned back into it.** These used to be hardcoded constants that
 * `supatype dev` wrote to `.env` on every run, which meant a project could not hold its own
 * secrets: whatever `supatype init` or the developer put there was replaced by the published
 * defaults on the next `dev`, and the same `.env` then went to a server. Resolving instead of
 * pinning is what lets a generated secret survive to production.
 *
 * The constants remain as *fallbacks* so a project without `.env` still starts, and so the
 * behaviour of an existing project is unchanged.
 */

import { randomBytes } from "node:crypto"
import { hasEnvValue, readEnvValue, upsertEnvFile } from "./env-file.js"
import { verifyJwt } from "./jwt.js"
import {
  GIVEN_JWT_SECRET_REMEDY,
  JWT_SECRET_REMEDY,
  jwtSecretTooShort,
  jwtSecretUnwritable,
} from "./jwt-secret-rules.js"
import { usesExternalDatabase, type SupatypeProjectConfig } from "./project-config.js"

/**
 * The secret the gateway presents to the control plane, and the only thing the control plane
 * accepts as proof a request came through the gateway.
 *
 * The control plane listens on the compose network, which the functions worker shares, and the
 * worker runs user code. So the compose file hands this to the server and the control plane and
 * to nothing else.
 */
export const CONTROL_PLANE_SECRET_ENV = "SUPATYPE_CONTROL_PLANE_SECRET"

/** A new control plane secret: 32 random bytes, base64url, so 43 characters. */
export function generateControlPlaneSecret(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Generate the control plane secret into `.env` when the project has none.
 *
 * **Generated, unlike the fallbacks below.** Those keep the value an existing project has been
 * running with, because changing it would break tokens or a database volume. Nothing holds a
 * control plane secret before it is written, so there is nothing to preserve, and a published
 * default would be readable by the very code it keeps out.
 *
 * Written once and then left alone: `.env` is compose's input, so a value that changed on every
 * run would restart the server and the control plane every time. A project that predates the
 * secret gets one on its next `dev` or `self-host` command, and compose recreates both services
 * because their environment changed.
 */
export function ensureControlPlaneSecret(cwd: string): void {
  if (hasEnvValue(cwd, CONTROL_PLANE_SECRET_ENV)) return
  upsertEnvFile(cwd, { [CONTROL_PLANE_SECRET_ENV]: generateControlPlaneSecret() })
}

/** A new JWT signing secret: 48 random bytes, base64url, so 64 characters. */
export function generateJwtSecret(): string {
  return randomBytes(48).toString("base64url")
}

/** Fallback Postgres superuser password for a project that has none. */
export const FALLBACK_POSTGRES_PASSWORD = "postgres"

/** Fallback password for the role PostgREST connects as. */
export const FALLBACK_AUTHENTICATOR_PASSWORD = "authenticator-local"

/** Fallback password for `supatype_sql_editor`, the role Studio's SQL editor connects as. */
export const FALLBACK_SQL_EDITOR_PASSWORD = "sql-editor-local"

/** The `.env` key holding the SQL editor role's password. */
export const SQL_EDITOR_PASSWORD_ENV = "SUPATYPE_SQL_EDITOR_PASSWORD"

/**
 * The superuser the bundled Postgres image runs as. Its first start checks the cluster as this
 * role, so it is not a choice the project gets to make, and not a value read from `.env`.
 */
export const BUNDLED_DB_USER = "supatype_admin"

/**
 * The secret the local stack signs and validates tokens with: `.env`'s, or one written there first.
 *
 * Generated rather than defaulted. A published fallback let anyone mint a token for a stack using
 * it, and the docker dev path wrote it into the same `.env` a server reads. A secret a project
 * already has is kept, whatever it is, because replacing it invalidates every token issued. A
 * `.env` without one gets the shell's when it is usable, as everywhere else ({@link newJwtSecret}).
 */
export function devJwtSecret(cwd: string): string {
  const inFile = readEnvValue(cwd, "JWT_SECRET", "")
  if (inFile !== "") return inFile
  const { secret, problem } = newJwtSecret(givenJwtSecret())
  if (problem !== undefined) console.warn(`[supatype] ${problem} Generated a JWT_SECRET for .env instead.`)
  upsertEnvFile(cwd, { JWT_SECRET: secret })
  return secret
}

/**
 * The names compose would take from the shell ahead of `--env-file`, where the CLI wants `.env`'s:
 * the keys in `.env` are signed with its JWT_SECRET, so a different one from the shell would start
 * the stack verifying with a secret those keys do not match, and refuse every request.
 */
export const ENV_FILE_OVER_SHELL = ["JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY"] as const

/** The role a key under each name has to carry. */
const KEY_ROLES = { ANON_KEY: "anon", SERVICE_ROLE_KEY: "service_role" } as const

/**
 * Whether the stack would accept `key` as `role`: signed with `secret`, issued by Supatype for that
 * role, and not expiring within `validForSeconds`.
 */
export function keyUsable(key: string, role: string, secret: string, validForSeconds = 0): boolean {
  const claims = key === "" ? null : verifyJwt(key, secret)
  if (claims === null || claims["role"] !== role || claims["iss"] !== "supatype") return false
  const expiry = claims["exp"]
  return typeof expiry !== "number" || expiry > Math.floor(Date.now() / 1000) + validForSeconds
}

/**
 * Whether compose runs without the shell's `shellValue` for `name`, so the stack gets `.env`'s.
 * Always when `.env` defines the name. For a key `.env` leaves blank, only when `.env` holds a
 * JWT_SECRET and the shell's key is not one the stack would accept under it ({@link keyUsable}):
 * a usable one is kept, since the compose file requires SERVICE_ROLE_KEY to be set at all.
 */
export function envFileOverridesShell(
  env: Record<string, string>,
  name: (typeof ENV_FILE_OVER_SHELL)[number],
  shellValue: string | undefined,
): boolean {
  if ((env[name] ?? "") !== "") return true
  const secret = env["JWT_SECRET"] ?? ""
  if (name === "JWT_SECRET" || secret === "" || shellValue === undefined || shellValue === "") return false
  return !keyUsable(shellValue, KEY_ROLES[name], secret)
}

/** A JWT secret given to a run rather than read from `.env`, with where it came from. */
export interface GivenJwtSecret {
  value: string
  source: string
  /** Passed as `--secret`, which is refused rather than overridden when `.env` holds another. */
  fromFlag: boolean
}

/** `--secret` when one was passed, else the shell's JWT_SECRET, which compose reads ahead of `.env`. */
export function givenJwtSecret(flag?: string): GivenJwtSecret | undefined {
  if (flag !== undefined) return { value: flag, source: "--secret", fromFlag: true }
  const fromShell = process.env["JWT_SECRET"]
  if (!fromShell) return undefined
  return { value: fromShell, source: "the JWT_SECRET environment variable", fromFlag: false }
}

/**
 * The secret for a `.env` that has none: `given` when `.env` can hold it and the stack can use it,
 * else a generated one, with why `given` was passed over. For the callers that carry on regardless
 * (`init`, `dev`), where a refusal would strand a half-made project or a starting session.
 */
export function newJwtSecret(given?: GivenJwtSecret): { secret: string; problem?: string } {
  if (given === undefined) return { secret: generateJwtSecret() }
  const problem = jwtSecretUnwritable(given.value, given.source)
  return problem === null ? { secret: given.value } : { secret: generateJwtSecret(), problem }
}

/** The JWT_SECRET keys written into `.env` are signed with, or why there is none to use. */
export type EnvJwtSecret =
  | {
      ok: true
      secret: string
      /** The JWT_SECRET to upsert beside the keys: empty when `.env` already holds it. */
      write: Record<string, string>
      /** Where a newly written secret came from. Its keys have to be signed again. */
      note?: string
      /** A given secret differing from `.env`'s, which is not used. */
      warning?: string
    }
  | { ok: false; problem: string; hints: readonly string[] }

/**
 * The one resolver for the secret that keys written into `.env` are signed with. `.env`'s always
 * wins, since `.env` is what every later run of the stack reads, and compose is run without the
 * shell's copy when `.env` has one (self-host-compose.ts). A `given` secret is written into a `.env`
 * that has none, else one is generated; a `given` one that differs from `.env`'s earns a warning.
 *
 * Checked before anything is written, so keys are never signed with a secret the stack then
 * refuses. A `--secret` that differs from `.env`'s is refused by `keys` before it gets here.
 */
export function resolveEnvJwtSecret(env: Record<string, string>, given?: GivenJwtSecret): EnvJwtSecret {
  const inFile = env["JWT_SECRET"] ?? ""
  if (inFile === "") return writtenEnvJwtSecret(given)
  const short = jwtSecretTooShort(inFile)
  if (short !== null) return { ok: false, problem: short, hints: JWT_SECRET_REMEDY }
  const warning = ignoredJwtSecretWarning(inFile, given)
  return { ok: true, secret: inFile, write: {}, ...(warning !== undefined && { warning }) }
}

/** The one line said when `given` differs from `.env`'s JWT_SECRET, which is used instead. */
export function ignoredJwtSecretWarning(inFile: string, given: GivenJwtSecret | undefined): string | undefined {
  if (given === undefined || given.value === inFile) return undefined
  return `${given.source} differs from the JWT_SECRET in .env, so this run uses the one in .env.`
}

function writtenEnvJwtSecret(given: GivenJwtSecret | undefined): EnvJwtSecret {
  const secret = given?.value ?? generateJwtSecret()
  const problem = given === undefined ? null : jwtSecretUnwritable(secret, given.source)
  if (problem !== null) return { ok: false, problem, hints: GIVEN_JWT_SECRET_REMEDY }
  const from =
    given === undefined ? "Generated a JWT_SECRET in .env" : `Wrote JWT_SECRET into .env from ${given.source}`
  const note =
    `${from}, since .env had none, and signed ANON_KEY and SERVICE_ROLE_KEY with it, ` +
    "replacing any keys .env held."
  return { ok: true, secret, write: { JWT_SECRET: secret }, note }
}

/** The password for the Postgres superuser the engine and server connect as. */
export function devPostgresPassword(cwd: string): string {
  return readEnvValue(cwd, "POSTGRES_PASSWORD", FALLBACK_POSTGRES_PASSWORD)
}

/**
 * The native superuser's password: `.env`'s, or a generated one written there first.
 *
 * Native Postgres checks passwords now, so the published fallback would be a superuser password
 * anyone can look up. Unlike the docker path there is no volume baked with an older password to
 * stay compatible with: a native cluster made before is converted from trust on its next start
 * and given this one.
 */
export function ensureNativeSuperuserPassword(cwd: string): string {
  ensureGeneratedPassword(cwd, "POSTGRES_PASSWORD")
  return devPostgresPassword(cwd)
}

/**
 * The native `authenticator` password, generated the same way. It is set on the role at every
 * start (native-roles-sql.ts), and the role reaches `service_role`, so a published value would
 * open every table.
 */
export function ensureNativeAuthenticatorPassword(cwd: string): string {
  ensureGeneratedPassword(cwd, "AUTHENTICATOR_PASSWORD")
  return devAuthenticatorPassword(cwd)
}

function ensureGeneratedPassword(cwd: string, key: string): void {
  if (!hasEnvValue(cwd, key)) upsertEnvFile(cwd, { [key]: randomBytes(24).toString("base64url") })
}

/**
 * The password for `authenticator`, the role PostgREST connects as.
 *
 * Separate from {@link devPostgresPassword} for the same reason the deployed paths keep them
 * apart: rotating the operator's database password must not take the REST API down.
 */
export function devAuthenticatorPassword(cwd: string): string {
  return readEnvValue(cwd, "AUTHENTICATOR_PASSWORD", FALLBACK_AUTHENTICATOR_PASSWORD)
}

/**
 * The password for `supatype_sql_editor`, the non-superuser role Studio's SQL editor connects as.
 *
 * Its own credential for the same reason as {@link devAuthenticatorPassword}: rotating the
 * owner's password must not lock the editor out, and the editor must never hold the owner's.
 */
export function devSqlEditorPassword(cwd: string): string {
  return readEnvValue(cwd, SQL_EDITOR_PASSWORD_ENV, FALLBACK_SQL_EDITOR_PASSWORD)
}

/**
 * The secrets that are missing from `.env` and must be written so the stack can start.
 *
 * The compose template requires these with `${VAR:?}` rather than defaulting them, because a
 * default is how a published constant ends up signing a real deployment's tokens. That only
 * works if something guarantees presence, this does, for any project that predates
 * `supatype init` writing them.
 *
 * **Fills with the fallback, does not generate.** Preserving the value such a project has been
 * running with is the point: a new `POSTGRES_PASSWORD` would not match the password baked into an
 * existing Postgres volume, which `initdb` only sets once. New projects get generated values from
 * `init`; existing ones keep working and are no worse off than before.
 *
 * Not `JWT_SECRET`: {@link devJwtSecret} generates that one, and every caller signs its keys
 * through it before this runs.
 *
 * `POSTGRES_PASSWORD` only for the bundled database. An external one is reached through the
 * operator's `DATABASE_URL`, and a fallback password beside it describes a credential that does
 * not exist.
 */
export function seedMissingLocalSecrets(
  cwd: string,
  config: SupatypeProjectConfig,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!usesExternalDatabase(config) && !hasEnvValue(cwd, "POSTGRES_PASSWORD")) {
    out.POSTGRES_PASSWORD = FALLBACK_POSTGRES_PASSWORD
  }
  if (!hasEnvValue(cwd, "AUTHENTICATOR_PASSWORD")) {
    out.AUTHENTICATOR_PASSWORD = FALLBACK_AUTHENTICATOR_PASSWORD
  }
  if (!hasEnvValue(cwd, SQL_EDITOR_PASSWORD_ENV)) {
    out[SQL_EDITOR_PASSWORD_ENV] = FALLBACK_SQL_EDITOR_PASSWORD
  }
  return out
}

/**
 * The database identity the local stack connects with, seeded, never overwritten.
 *
 * `POSTGRES_DB` in particular is *project configuration*: `supatype init` sets it to the
 * project name, and the running container's database was created from it. Rewriting it to a
 * default afterwards points every tool at a database that does not exist, observed as
 * `supatype push` failing with `FATAL: database "supatype" does not exist` on a project called
 * something else, because the push path rewrote `.env` after `self-host compose up` had already
 * created the database under its real name.
 *
 * Seeded values match the compose file's own `${VAR:-default}`, so an absent key behaves
 * exactly as it did before.
 *
 * Nothing for an external database: both keys describe the bundled `db` container, and the
 * operator's `DATABASE_URL` already names the user and database the stack connects to.
 */
export function seedMissingDatabaseIdentity(
  cwd: string,
  config: SupatypeProjectConfig,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (usesExternalDatabase(config)) return out
  if (!hasEnvValue(cwd, "POSTGRES_USER")) out.POSTGRES_USER = BUNDLED_DB_USER
  if (!hasEnvValue(cwd, "POSTGRES_DB")) out.POSTGRES_DB = "supatype"
  return out
}

/** Who the local database belongs to and what it is called, as the stack was created with it. */
export interface DevDatabaseIdentity {
  user: string
  password: string
  database: string
}

/**
 * The local database's owner, password and name.
 *
 * The password and database name are the project's own, read from `.env`. The user is always
 * {@link BUNDLED_DB_USER}: the bundled image runs as that role whatever `.env` says.
 *
 * Every `psql` the CLI runs in the `db` container and every connection string it writes comes
 * through here, so a project's own credentials cannot be read by one path and assumed by another.
 */
export function devDatabaseIdentity(cwd: string): DevDatabaseIdentity {
  return {
    user: BUNDLED_DB_USER,
    password: devPostgresPassword(cwd),
    database: readEnvValue(cwd, "POSTGRES_DB", "supatype"),
  }
}

/** A connection string to the local database at `hostPort`, `db:5432` inside the network. */
export function devDatabaseUrl(cwd: string, hostPort: string): string {
  const { user, password, database } = devDatabaseIdentity(cwd)
  return `postgresql://${user}:${encodeURIComponent(password)}@${hostPort}/${database}?sslmode=disable`
}

/**
 * A short, non-reversible tag for a secret, safe to print.
 *
 * The ready panel used to echo the JWT secret in full, which was harmless while it was a
 * published constant and is not once it is the project's own.
 */
export function secretFingerprint(secret: string): string {
  let hash = 5381
  for (let i = 0; i < secret.length; i++) hash = ((hash << 5) + hash + secret.charCodeAt(i)) | 0
  return (hash >>> 0).toString(16).padStart(8, "0")
}
