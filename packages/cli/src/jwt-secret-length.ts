/**
 * The JWT secret has to be long enough for PostgREST to start with it.
 *
 * PostgREST 13 and later refuse a secret shorter than 32 characters. Everything else in the stack
 * accepts one, so without this check the stack comes up whole except for the REST API, which
 * restarts in a loop and gives its reason only in its own log.
 *
 * The rules themselves are in `jwt-secret-rules.ts`, which has no terminal UI so that
 * `local-secrets.ts` can use them; this module adds the refusal.
 */

import { JWT_SECRET_REMEDY, jwtSecretTooShort } from "./jwt-secret-rules.js"
import { fatalError } from "./ui/fatal.js"

export { JWT_SECRET_REMEDY, MIN_JWT_SECRET_LENGTH, jwtSecretTooShort } from "./jwt-secret-rules.js"

/** Stop before starting a stack whose REST API could not start with `secret`, named by `where`. */
export function requireUsableJwtSecret(secret: string, where?: string): void {
  const problem = jwtSecretTooShort(secret, where)
  if (problem === null) return
  fatalError(problem, [...JWT_SECRET_REMEDY])
}
