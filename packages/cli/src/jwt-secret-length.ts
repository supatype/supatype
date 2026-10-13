/**
 * The JWT secret has to be long enough for PostgREST to start with it.
 *
 * PostgREST 13 and later refuse a secret shorter than 32 characters. Everything else in the stack
 * accepts one, so without this check the stack comes up whole except for the REST API, which
 * restarts in a loop and gives its reason only in its own log.
 *
 * Kept out of `local-secrets.ts` on purpose: that module is imported widely, and the fatal error
 * below brings in the terminal UI.
 */

import { fatalError } from "./ui/fatal.js"

/** The shortest JWT secret PostgREST will start with. */
export const MIN_JWT_SECRET_LENGTH = 32

/** Why `secret` cannot sign this stack's tokens, or null when it can. */
export function jwtSecretTooShort(secret: string): string | null {
  if (secret.length >= MIN_JWT_SECRET_LENGTH) return null
  return (
    `JWT_SECRET in .env is ${secret.length} characters, and the REST API needs at least ` +
    `${MIN_JWT_SECRET_LENGTH}.`
  )
}

/** Stop before starting a stack whose REST API could not start with `secret`. */
export function requireUsableJwtSecret(secret: string): void {
  const problem = jwtSecretTooShort(secret)
  if (problem === null) return
  fatalError(problem, [
    "Generate a longer one, for example with `openssl rand -base64 48`, and put it in .env as JWT_SECRET.",
    "Then run `supatype keys --write` to sign ANON_KEY and SERVICE_ROLE_KEY with it.",
  ])
}
