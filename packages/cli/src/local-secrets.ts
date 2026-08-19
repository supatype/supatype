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

import { hasEnvValue, readEnvValue } from "./env-file.js"

/**
 * Fallback JWT signing secret for a project that has none.
 *
 * Published, therefore worthless as a secret, anyone can mint a token for a stack still using
 * it. That is precisely why `init` generates one instead of relying on this.
 */
export const FALLBACK_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

/** Fallback Postgres superuser password for a project that has none. */
export const FALLBACK_POSTGRES_PASSWORD = "postgres"

/** Fallback password for the role PostgREST connects as. */
export const FALLBACK_AUTHENTICATOR_PASSWORD = "authenticator-local"

/** The secret the local stack signs and validates tokens with. */
export function devJwtSecret(cwd: string): string {
  return readEnvValue(cwd, "JWT_SECRET", FALLBACK_JWT_SECRET)
}

/** The password for the Postgres superuser the engine and server connect as. */
export function devPostgresPassword(cwd: string): string {
  return readEnvValue(cwd, "POSTGRES_PASSWORD", FALLBACK_POSTGRES_PASSWORD)
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
 * The secrets that are missing from `.env` and must be written so the stack can start.
 *
 * The compose template requires these with `${VAR:?}` rather than defaulting them, because a
 * default is how a published constant ends up signing a real deployment's tokens. That only
 * works if something guarantees presence, this does, for any project that predates
 * `supatype init` writing them.
 *
 * **Fills with the fallback, does not generate.** Preserving the value such a project has been
 * running with is the point: generating a new `JWT_SECRET` would invalidate tokens already
 * issued, and a new `POSTGRES_PASSWORD` would not match the password baked into an existing
 * Postgres volume, which `initdb` only sets once. New projects get generated values from
 * `init`; existing ones keep working and are no worse off than before.
 */
export function seedMissingLocalSecrets(cwd: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!hasEnvValue(cwd, "JWT_SECRET")) out.JWT_SECRET = FALLBACK_JWT_SECRET
  if (!hasEnvValue(cwd, "POSTGRES_PASSWORD")) out.POSTGRES_PASSWORD = FALLBACK_POSTGRES_PASSWORD
  if (!hasEnvValue(cwd, "AUTHENTICATOR_PASSWORD")) {
    out.AUTHENTICATOR_PASSWORD = FALLBACK_AUTHENTICATOR_PASSWORD
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
 */
export function seedMissingDatabaseIdentity(cwd: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!hasEnvValue(cwd, "POSTGRES_USER")) out.POSTGRES_USER = "supatype_admin"
  if (!hasEnvValue(cwd, "POSTGRES_DB")) out.POSTGRES_DB = "supatype"
  return out
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
