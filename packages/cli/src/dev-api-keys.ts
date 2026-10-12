/**
 * The anon and service-role keys a docker project's stack is configured with.
 */

import { readEnvFile, readEnvValue } from "./env-file.js"
import { signJwt, verifyJwt } from "./jwt.js"
import { devJwtSecret } from "./local-secrets.js"

/** Ten years, as the keys have always been minted. */
const KEY_LIFETIME_SECONDS = 315_360_000

/** A key closer than this to expiry is replaced rather than kept. */
const RENEW_WITHIN_SECONDS = 86_400

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
 * The service-role key the project's running stack was configured with, read from `.env` as the
 * stack reads it, or undefined when `.env` has none.
 *
 * Read, never signed: a key minted here verifies only if it was signed with the secret the stack
 * started with, and an absent key is a clearer failure than a refused one.
 */
export function configuredServiceRoleKey(cwd: string): string | undefined {
  const key =
    readEnvValue(cwd, "SUPATYPE_SERVICE_ROLE_KEY", "").trim() ||
    readEnvValue(cwd, "SERVICE_ROLE_KEY", "").trim()
  return key === "" ? undefined : key
}

function keptOrSigned(existing: string | undefined, role: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const claims = existing !== undefined && existing !== "" ? verifyJwt(existing, secret) : null
  const expiry = claims?.["exp"]
  const usable =
    claims !== null &&
    claims["role"] === role &&
    claims["iss"] === "supatype" &&
    (typeof expiry !== "number" || expiry > now + RENEW_WITHIN_SECONDS)
  if (usable && existing !== undefined) return existing
  return signJwt({ iss: "supatype", iat: now, exp: now + KEY_LIFETIME_SECONDS, role }, secret)
}
