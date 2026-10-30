import type { Command } from "commander"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { readEnvFile, readEnvValue, upsertEnvFile } from "../env-file.js"
import { signJwt } from "../jwt.js"
import { requireUsableJwtSecret } from "../jwt-secret-length.js"
import { GIVEN_JWT_SECRET_REMEDY, jwtSecretUnwritable } from "../jwt-secret-rules.js"
import {
  generateJwtSecret,
  givenJwtSecret,
  resolveEnvJwtSecret,
  type EnvJwtSecret,
  type GivenJwtSecret,
} from "../local-secrets.js"
import { fatalError } from "../ui/fatal.js"
import { error, plain, warn } from "../ui/messages.js"

interface KeysOptions {
  secret?: string
  expYears: string
  print?: boolean
  write?: boolean
  force?: boolean
}

export function registerKeys(program: Command): void {
  program
    .command("keys")
    .description(
      "Generate ANON_KEY and SERVICE_ROLE_KEY JWTs from your JWT_SECRET and fill the blank ones in .env " +
        "(printed instead when there is no .env, or with --print)",
    )
    .option(
      "--secret <secret>",
      "JWT secret (default: .env's JWT_SECRET, else the JWT_SECRET env var). Writing into .env, it must match .env's",
    )
    .option("--exp-years <years>", "Token expiry in years (default: 10)", "10")
    .option("--print", "Only print the keys, even when there is a .env to write them to")
    .option("--write", "Write the keys into .env. The default when there is one; kept for older scripts")
    .option("--force", "Replace every key already in .env rather than filling blanks")
    .action((opts: KeysOptions) => {
      const expYears = parseInt(opts.expYears, 10)
      if (isNaN(expYears) || expYears < 1) {
        error("--exp-years must be a positive integer")
        process.exit(1)
      }
      if (opts.print === true && opts.write === true) {
        error("--print and --write contradict each other. Pass one.")
        process.exit(1)
      }

      const cwd = process.cwd()
      const hasEnv = existsSync(resolve(cwd, ".env"))
      if (opts.write === true && !hasEnv) {
        error("No .env here to write to. Create one, or drop --write to print the keys.")
        process.exit(1)
      }
      if (hasEnv && opts.print !== true) writeKeys(cwd, opts, expYears)
      else printKeys(cwd, opts, expYears, hasEnv)
    })
}

/** `supatype keys` with a `.env` to write to: blanks only unless `--force` or a new JWT_SECRET. */
function writeKeys(cwd: string, opts: KeysOptions, expYears: number): void {
  const env = readEnvFile(cwd)
  const given = givenJwtSecret(opts.secret)
  refuseSecretFlagConflict(env, given)
  const resolved = requireEnvJwtSecret(env, given)
  const keys = signKeyPair(resolved.secret, expYears)
  // Keys already in .env cannot verify against a secret written beside them now, so they go too.
  const replace = opts.force === true || resolved.write["JWT_SECRET"] !== undefined
  const written = writeKeysToEnv(cwd, keys, replace, { env, secret: resolved.write })
  if (resolved.warning !== undefined) warn(resolved.warning)
  if (resolved.note !== undefined) plain(`\n${resolved.note}`)
  plain(`\nKeys valid for ${expYears} years, written to ${written.path ?? ".env"}:\n`)
  // The names come back from the writer rather than being restated here, which is the whole
  // point of there being one list.
  for (const key of written.written) plain(`  ${key}`)
  if (written.kept.length > 0) {
    plain(`\nLeft alone, because they already hold a value:\n`)
    for (const key of written.kept) plain(`  ${key}`)
    plain("\nRe-run with --force to replace them.")
  }
  plain("\nDo not commit .env to source control.")
}

/**
 * Stop when `--secret` differs from the JWT_SECRET already in `.env`.
 *
 * Refused rather than overridden, unlike a differing shell JWT_SECRET, which is only warned about:
 * the flag was typed for this run, so ignoring it would sign the keys with a secret the person did
 * not ask for. Keys in `.env` have to verify against the secret `.env` holds.
 */
function refuseSecretFlagConflict(env: Record<string, string>, given: GivenJwtSecret | undefined): void {
  const inFile = env["JWT_SECRET"] ?? ""
  if (given?.fromFlag !== true || inFile === "" || given.value === inFile) return
  fatalError(
    "--secret differs from the JWT_SECRET in .env, and keys in .env have to be signed with the " +
      "secret in .env, which is the one the stack verifies them against.",
    [
      "To sign with the other secret, set it as JWT_SECRET in .env and re-run.",
      "To only print keys signed with it, add --print.",
    ],
  )
}

/** {@link resolveEnvJwtSecret}, stopping before anything is written when there is no usable secret. */
function requireEnvJwtSecret(
  env: Record<string, string>,
  given: GivenJwtSecret | undefined,
): Extract<EnvJwtSecret, { ok: true }> {
  const resolved = resolveEnvJwtSecret(env, given)
  if (!resolved.ok) fatalError(resolved.problem, [...resolved.hints])
  return resolved
}

/**
 * `supatype keys` printing instead of writing. With no `.env` and no secret, one is generated and
 * printed with the keys, since keys signed with a secret nobody kept could never be verified.
 * `--print` never makes one up: a secret it printed would not be the one a later write generates.
 */
function printKeys(cwd: string, opts: KeysOptions, expYears: number, hasEnv: boolean): void {
  const known = printedKeysSecret(cwd, opts.secret)
  if (known === undefined && opts.print === true) {
    error("No JWT_SECRET to sign the keys with: none in .env, --secret or the environment.")
    plain(
      hasEnv
        ? "Run `supatype keys` without --print to generate one and write it into .env with the keys."
        : "Run `supatype keys` without --print to generate one and print it with the keys.",
    )
    process.exit(1)
  }
  const secret = known ?? generateJwtSecret()
  const { anonKey, serviceKey } = signKeyPair(secret, expYears)
  plain(`\nGenerated keys (valid for ${expYears} years):\n`)
  if (known === undefined) plain("JWT_SECRET=" + secret)
  plain("ANON_KEY=" + anonKey)
  plain("SERVICE_ROLE_KEY=" + serviceKey)
  plain(
    hasEnv
      ? "\nRe-run without --print to fill the blank ones in .env. Do not commit .env to source control."
      : "\nCreate a .env here and re-run `supatype keys` to write them into it, or add these lines yourself. " +
          "Do not commit .env to source control.",
  )
}

/**
 * The secret printed keys are signed with: `--secret`, else `.env`'s ahead of the shell's, as when
 * writing, since `.env`'s is the one the stack verifies with. Checked as a written one is, since
 * printed keys and their secret end up in a `.env` all the same: `.env`'s for length, a given one
 * also for what `.env` cannot hold unquoted.
 */
function printedKeysSecret(cwd: string, flag: string | undefined): string | undefined {
  const fromEnvFile = readEnvValue(cwd, "JWT_SECRET", "")
  const given = givenJwtSecret(flag)
  if (given?.fromFlag !== true && fromEnvFile !== "") {
    requireUsableJwtSecret(fromEnvFile, "JWT_SECRET in .env")
    return fromEnvFile
  }
  if (given === undefined) return undefined
  const problem = jwtSecretUnwritable(given.value, given.source)
  if (problem !== null) fatalError(problem, [...GIVEN_JWT_SECRET_REMEDY])
  return given.value
}

/**
 * Every env name a minted key pair is written to, in one place.
 *
 * Shared with `supatype dev`, which writes the same pair when it starts a stack. They used to hold
 * separate lists, so a front end's prefix could be written by one and forgotten by the other, and
 * which names your `.env` ended up with depended on whichever command you happened to run last.
 *
 * The URL names are only included when there is a URL to write, because an empty
 * `VITE_SUPATYPE_URL` is worse than an absent one: the client reads it, finds a blank string, and
 * requests against the page origin without saying why.
 */
export function anonKeyEnvUpdates(
  anonKey: string,
  serviceKey: string,
  apiUrl?: string | undefined,
): Record<string, string> {
  return {
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceKey,
    VITE_SUPATYPE_ANON_KEY: anonKey,
    PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    EXPO_PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    NEXT_PUBLIC_SUPATYPE_ANON_KEY: anonKey,
    ...(apiUrl !== undefined && {
      VITE_SUPATYPE_URL: apiUrl,
      PUBLIC_SUPATYPE_URL: apiUrl,
      EXPO_PUBLIC_SUPATYPE_URL: apiUrl,
      NEXT_PUBLIC_SUPATYPE_URL: apiUrl,
    }),
  }
}

/** The API URL a project's `.env` records, for the front-end URL copies, or undefined. */
function recordedApiUrl(env: Record<string, string>): string | undefined {
  return env["PUBLIC_SUPATYPE_URL"] || env["API_EXTERNAL_URL"] || undefined
}

export interface WriteKeysResult {
  /** The .env written, or null when there is none here. */
  path: string | null
  written: string[]
  kept: string[]
}

/** What a caller that has already read `.env` hands {@link writeKeysToEnv}. */
export interface WriteKeysContext {
  /** `.env` as the caller read it, so it is not read twice. */
  env?: Record<string, string>
  /** A JWT_SECRET to write in the same upsert as the keys it signed. */
  secret?: Record<string, string>
}

/**
 * Write a minted pair into `dir`'s .env.
 *
 * Blanks only by default. An anon key already in `.env` is held by clients this command cannot
 * reach, and reissuing it locks them out, so filling what is empty is the useful half and
 * replacing what is not is a decision someone has to make out loud. `--force` is how they make it,
 * and it rewrites every name this owns rather than only the empty ones.
 *
 * `--force` does not rewrite the file. `.env` also holds `JWT_SECRET`, which these keys are
 * derived from, along with the database password and whatever else the project keeps there;
 * replacing the file would leave a project whose keys cannot be regenerated and whose stack cannot
 * start. Every line this command does not own is left exactly as it was, comments included.
 */
export function writeKeysToEnv(
  dir: string,
  keys: { anonKey: string; serviceKey: string },
  force: boolean,
  context: WriteKeysContext = {},
): WriteKeysResult {
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return { path: null, written: [], kept: [] }

  const existing = context.env ?? readEnvFile(dir)
  const candidates = anonKeyEnvUpdates(keys.anonKey, keys.serviceKey, recordedApiUrl(existing))

  const updates: Record<string, string> = {}
  const kept: string[] = []
  for (const [name, value] of Object.entries(candidates)) {
    // Blank counts as absent: a template ships `ANON_KEY=` and that is exactly the line to fill.
    const current = existing[name]?.trim() ?? ""
    if (!force && current !== "") {
      kept.push(name)
      continue
    }
    updates[name] = value
  }

  const upserts = { ...context.secret, ...updates }
  if (Object.keys(upserts).length > 0) upsertEnvFile(dir, upserts)
  return { path: envPath, written: Object.keys(updates), kept }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mint a long-lived anon + service_role JWT pair from a secret. */
export function signKeyPair(
  secret: string,
  expYears = 10,
): { anonKey: string; serviceKey: string } {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + expYears * 365 * 24 * 60 * 60
  return {
    anonKey: signJwt({ iss: "supatype", role: "anon", iat: now, exp }, secret),
    serviceKey: signJwt({ iss: "supatype", role: "service_role", iat: now, exp }, secret),
  }
}

/** `init`'s keys, or why there are none. Never exits: init is mid-wizard and reports it itself. */
export type GeneratedKeys =
  | { ok: true; anonKey: string; serviceKey: string }
  | { ok: false; reason: string }

/**
 * `init`'s keys: signed with the JWT_SECRET `dir`'s .env holds, and written over every name
 * {@link anonKeyEnvUpdates} owns in that .env, in place.
 *
 * Nothing is said about a shell JWT_SECRET that differs: init has just written `.env`'s from the
 * shell's, so it differs only when the shell's was unusable, and init said so when it wrote it.
 */
export function generateAndWriteKeys(dir: string, expYears = 10): GeneratedKeys {
  if (!existsSync(resolve(dir, ".env"))) return { ok: false, reason: "the project has no .env." }
  const env = readEnvFile(dir)
  const resolved = resolveEnvJwtSecret(env, givenJwtSecret())
  if (!resolved.ok) return { ok: false, reason: resolved.problem }
  const keys = signKeyPair(resolved.secret, expYears)
  writeKeysToEnv(dir, keys, true, { env, secret: resolved.write })
  return { ok: true, ...keys }
}

/** What `self-host compose up` filled in `.env`. */
export interface FilledKeys {
  /** The key names minted into `.env`. */
  filled: string[]
  /** Set when JWT_SECRET itself was written into `.env`, saying where it came from. */
  note?: string
  /** Set when the shell's JWT_SECRET differs from `.env`'s, which is the one used. */
  warning?: string
}

const KEY_NAMES = ["ANON_KEY", "SERVICE_ROLE_KEY"] as const

/**
 * Mint ANON_KEY / SERVICE_ROLE_KEY into `dir`'s .env only where they are
 * missing or blank, and report which ones were filled.
 *
 * Deliberately not `generateAndWriteKeys`, which rewrites them unconditionally.
 * That is right for `init`, where the project is new, and wrong for anything
 * that runs on an existing deployment: reissuing the anon key on every start
 * would lock out every client already holding one.
 *
 * A self-host `.env` copied from the template arrives with both keys empty, and
 * the server refuses to serve without a service role key outside dev mode. That
 * left the documented quick start unable to start at all.
 *
 * Both are minted again when JWT_SECRET is newly written into `.env`, since keys already there
 * cannot verify against it. The secret is checked before anything is written.
 */
export function fillMissingKeys(dir: string, expYears = 10): FilledKeys {
  const given = givenJwtSecret()
  if (!existsSync(resolve(dir, ".env"))) {
    // Compose will run with the shell's secret, so it is the one PostgREST has to accept.
    if (given !== undefined) requireUsableJwtSecret(given.value, given.source)
    return { filled: [] }
  }
  const env = readEnvFile(dir)
  const { secret, write, note, warning } = requireEnvJwtSecret(env, given)
  const newSecret = write["JWT_SECRET"] !== undefined
  const needed = KEY_NAMES.filter((name) => newSecret || (env[name]?.trim() ?? "") === "")
  const said = { ...(note !== undefined && { note }), ...(warning !== undefined && { warning }) }
  if (needed.length === 0) return { filled: [], ...said }

  const { anonKey, serviceKey } = signKeyPair(secret, expYears)
  const minted = { ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceKey }
  upsertEnvFile(dir, { ...write, ...Object.fromEntries(needed.map((name) => [name, minted[name]])) })
  return { filled: needed, ...said }
}
