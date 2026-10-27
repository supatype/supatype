import type { Command } from "commander"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { readEnvFile, upsertEnvFile } from "../env-file.js"
import { signJwt } from "../jwt.js"
import { generateJwtSecret } from "../local-secrets.js"
import { error, plain } from "../ui/messages.js"

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
    .option("--secret <secret>", "JWT secret (default: JWT_SECRET env var, else .env). Writing into .env, it must match .env's")
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

/** `supatype keys` with a `.env` to write to: blanks only unless `--force`. */
function writeKeys(cwd: string, opts: KeysOptions, expYears: number): void {
  const { secret, note } = envFileSecret(cwd, opts)
  const written = writeKeysToEnv(cwd, signKeyPair(secret, expYears), opts.force === true)
  if (note !== undefined) plain(`\n${note}`)
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

/** A secret given to this run rather than read from `.env`, with where it came from. */
interface GivenSecret {
  value: string
  source: string
}

function givenSecret(opts: KeysOptions): GivenSecret | undefined {
  if (opts.secret !== undefined) return { value: opts.secret, source: "--secret" }
  const fromShell = process.env["JWT_SECRET"]
  return fromShell ? { value: fromShell, source: "the JWT_SECRET environment variable" } : undefined
}

/**
 * The secret for keys written into `.env`: always the JWT_SECRET that file ends up holding, since
 * that is the one the stack verifies them against.
 *
 * A JWT_SECRET already in `.env` wins, and a different one given to this run is refused rather
 * than picked between: either choice would leave keys in `.env` that one of the two secrets cannot
 * verify. With none in `.env`, the given secret (or a generated one) is written there first.
 */
function envFileSecret(cwd: string, opts: KeysOptions): { secret: string; note?: string } {
  const inFile = readEnvFile(cwd)["JWT_SECRET"] || undefined
  const given = givenSecret(opts)
  if (inFile !== undefined) {
    if (given !== undefined && given.value !== inFile) {
      error(
        `${given.source} differs from the JWT_SECRET in .env, and keys written into .env have to be ` +
          "signed with the secret in .env, which is the one the stack verifies them against.",
      )
      plain(
        "To sign with the other secret, set it as JWT_SECRET in .env and re-run. " +
          "To only print keys signed with it, add --print.",
      )
      process.exit(1)
    }
    return { secret: inFile }
  }
  const secret = given?.value ?? generateJwtSecret()
  upsertEnvFile(cwd, { JWT_SECRET: secret })
  return {
    secret,
    note:
      given === undefined
        ? "Generated a JWT_SECRET in .env, which had none."
        : `Wrote JWT_SECRET into .env from ${given.source}, since .env had none.`,
  }
}

/**
 * `supatype keys` printing instead of writing. With no `.env` and no secret, one is generated and
 * printed with the keys, since keys signed with a secret nobody kept could never be verified.
 * `--print` never makes one up: a secret it printed would not be the one a later write generates.
 */
function printKeys(cwd: string, opts: KeysOptions, expYears: number, hasEnv: boolean): void {
  const known = opts.secret ?? resolveSecret(cwd)
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
): WriteKeysResult {
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return { path: null, written: [], kept: [] }

  const existing = readEnvFile(dir)
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

  if (Object.keys(updates).length > 0) upsertEnvFile(dir, updates)
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

/**
 * Generate keys from the JWT_SECRET found in `dir`'s .env (or env var) and
 * rewrite every name {@link anonKeyEnvUpdates} owns in that .env file in place.
 * Returns the minted pair, or null if no secret could be resolved.
 */
export function generateAndWriteKeys(
  dir: string,
  expYears = 10,
): { anonKey: string; serviceKey: string } | null {
  const secret = resolveSecret(dir)
  if (!secret) return null

  const { anonKey, serviceKey } = signKeyPair(secret, expYears)
  if (existsSync(resolve(dir, ".env"))) {
    upsertEnvFile(dir, anonKeyEnvUpdates(anonKey, serviceKey, recordedApiUrl(readEnvFile(dir))))
  }
  return { anonKey, serviceKey }
}

/** The JWT secret: the `JWT_SECRET` environment variable, else `dir`'s .env, read as compose reads it. */
export function resolveSecret(dir: string = process.cwd()): string | undefined {
  const fromEnv = process.env["JWT_SECRET"]
  if (fromEnv) return fromEnv
  try {
    return readEnvFile(dir)["JWT_SECRET"] || undefined
  } catch {
    // An unreadable .env is the same as none here: the caller says what to do without a secret.
    return undefined
  }
}

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
 */
export function fillMissingKeys(dir: string, expYears = 10): string[] {
  if (!existsSync(resolve(dir, ".env"))) return []

  const existing = readEnvFile(dir)
  const needed = (["ANON_KEY", "SERVICE_ROLE_KEY"] as const).filter(
    (name) => (existing[name]?.trim() ?? "") === "",
  )
  if (needed.length === 0) return []

  const secret = resolveSecret(dir)
  if (!secret) return []

  const { anonKey, serviceKey } = signKeyPair(secret, expYears)
  const minted = { ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceKey }
  upsertEnvFile(dir, Object.fromEntries(needed.map((name) => [name, minted[name]])))
  return needed
}
