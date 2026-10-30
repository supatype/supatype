/**
 * What a JWT secret has to be before the CLI signs keys with it or writes it into `.env`.
 *
 * Pure checks with no terminal UI, so `local-secrets.ts`, which is imported widely, can apply them
 * before it writes a secret. `jwt-secret-length.ts` turns them into a refusal.
 */

/** The shortest JWT secret PostgREST will start with. */
export const MIN_JWT_SECRET_LENGTH = 32

/**
 * Why `secret` cannot sign this stack's tokens, or null when it can. PostgREST 13 and later refuse
 * a secret shorter than 32 characters, so the stack would come up whole except for the REST API.
 * `where` names the secret in the message.
 */
export function jwtSecretTooShort(secret: string, where = "JWT_SECRET in .env"): string | null {
  if (secret.length >= MIN_JWT_SECRET_LENGTH) return null
  return `${where} is ${secret.length} characters, and the REST API needs at least ${MIN_JWT_SECRET_LENGTH}.`
}

/**
 * What changes an unquoted `.env` value: whitespace ends or is trimmed from it, `#` starts a
 * comment, and a quote starts a quoted value. The CLI writes the secret unquoted.
 */
const BREAKS_UNQUOTED_ENV_VALUE = /[\s#"'`]/

/** Why `secret`, named by `where`, cannot be written into `.env` and signed with, or null. */
export function jwtSecretUnwritable(secret: string, where: string): string | null {
  const short = jwtSecretTooShort(secret, where)
  if (short !== null) return short
  if (!BREAKS_UNQUOTED_ENV_VALUE.test(secret)) return null
  return `${where} contains whitespace, a # or a quote, which a value in .env cannot hold unquoted.`
}

/**
 * What to do about a short secret in `.env`. `--force`, because the keys already in .env were
 * signed with the old secret and `keys --write` on its own only fills blank ones.
 */
export const JWT_SECRET_REMEDY: readonly string[] = [
  "Generate a longer one, for example with `openssl rand -base64 48`, and put it in .env as JWT_SECRET.",
  "Then run `supatype keys --write --force` to sign ANON_KEY and SERVICE_ROLE_KEY with it again.",
]

/** What to do about a given secret that cannot be written into `.env`. */
export const GIVEN_JWT_SECRET_REMEDY: readonly string[] = [
  "Use one of at least 32 characters with no whitespace, # or quotes, for example from " +
    "`openssl rand -base64 48`, or leave JWT_SECRET unset to have one generated.",
]
