/**
 * The anon and service-role keys a docker project's stack is configured with.
 */

import { readEnvFile } from "./env-file.js"
import { signJwt } from "./jwt.js"
import { devJwtSecret, envFileOverridesShell, usableKeyClaims } from "./local-secrets.js"

/** Ten years, as the keys have always been minted. */
const KEY_LIFETIME_SECONDS = 315_360_000

export interface DevApiKeys {
  anonKey: string
  serviceRoleKey: string
}

/**
 * The keys in `.env` when they still verify against the project's secret, else newly signed ones.
 *
 * Every compose command used to sign a fresh pair, differing only in `iat`, and write it to `.env`.
 * That rewrote the file the stack reads, so the next `compose up -d` recreated every service that
 * carries a key, under a running `dev`, and a client holding the previous anon key had been handed
 * a different one for nothing. Keys are only re-signed when the secret, the role or the expiry
 * makes the old one unusable.
 */
export function devApiKeys(cwd: string): DevApiKeys {
  const secret = devJwtSecret(cwd)
  const env = readEnvFile(cwd)
  return {
    anonKey: keptOrSigned(env["ANON_KEY"], "anon", secret),
    serviceRoleKey: keptOrSigned(env["SERVICE_ROLE_KEY"], "service_role", secret),
  }
}

/**
 * The service-role key the project's running stack was configured with, or undefined when there is
 * none: `.env`'s SERVICE_ROLE_KEY, else the shell's when compose passes it to the stack
 * ({@link envFileOverridesShell}). Both the compose file and native dev start the server with
 * SERVICE_ROLE_KEY, so a SUPATYPE_SERVICE_ROLE_KEY in `.env` never reaches the stack, and is read
 * only when nothing else is there.
 *
 * Read, never signed: a key minted here verifies only if it was signed with the secret the stack
 * started with, and an absent key is a clearer failure than a refused one.
 */
export function configuredServiceRoleKey(cwd: string): string | undefined {
  const env = readEnvFile(cwd)
  return stackServiceRoleKey(env) ?? (env["SUPATYPE_SERVICE_ROLE_KEY"]?.trim() || undefined)
}

/**
 * The SERVICE_ROLE_KEY the stack is started with: `.env`'s, else the shell's when compose passes
 * it on ({@link envFileOverridesShell}), else undefined.
 */
function stackServiceRoleKey(env: Record<string, string>): string | undefined {
  const inFile = env["SERVICE_ROLE_KEY"]?.trim()
  if (inFile) return inFile
  const fromShell = process.env["SERVICE_ROLE_KEY"]?.trim()
  return fromShell && !envFileOverridesShell(env, "SERVICE_ROLE_KEY", fromShell) ? fromShell : undefined
}

/**
 * A service-role key the shell exported for the local stack, as that stack would accept it, or
 * undefined when the shell has none. `SUPATYPE_SERVICE_ROLE_KEY` is the CLI's own and taken as
 * given. A shell `SERVICE_ROLE_KEY` reaches the stack only while `.env` does not override it
 * (self-host-compose.ts), so once it does, `.env`'s SERVICE_ROLE_KEY is sent instead, or nothing.
 */
export function shellServiceRoleKey(cwd: string): string | undefined {
  const own = process.env["SUPATYPE_SERVICE_ROLE_KEY"]
  if (own) return own
  if (!process.env["SERVICE_ROLE_KEY"]) return undefined
  return stackServiceRoleKey(readEnvFile(cwd))
}

/** `existing` while the stack would accept it and it came from the CLI, else a newly signed key. */
function keptOrSigned(existing: string | undefined, role: string, secret: string): string {
  if (existing !== undefined && usableKeyClaims(existing, role, secret)?.["iss"] === "supatype") return existing
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ iss: "supatype", iat: now, exp: now + KEY_LIFETIME_SECONDS, role }, secret)
}
