import type { Command } from "commander"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { readEnvFile, upsertEnvFile } from "../env-file.js"
import { signJwt } from "../jwt.js"
import { error, plain } from "../ui/messages.js"

export function registerKeys(program: Command): void {
  program
    .command("keys")
    .description("Generate ANON_KEY and SERVICE_ROLE_KEY JWTs from your JWT_SECRET")
    .option("--secret <secret>", "JWT secret (defaults to JWT_SECRET env var or value in .env)")
    .option("--exp-years <years>", "Token expiry in years (default: 10)", "10")
    .option("--write", "Write the keys into .env in the current directory instead of printing them")
    .option("--force", "With --write, replace every key already in .env rather than filling blanks")
    .action((opts: { secret?: string; expYears: string; write?: boolean; force?: boolean }) => {
      const secret = opts.secret ?? resolveSecret()
      if (!secret) {
        error("JWT_SECRET not found. Set it in .env or pass --secret <value>")
        process.exit(1)
      }

      const expYears = parseInt(opts.expYears, 10)
      if (isNaN(expYears) || expYears < 1) {
        error("--exp-years must be a positive integer")
        process.exit(1)
      }

      const { anonKey, serviceKey } = signKeyPair(secret, expYears)

      if (opts.write) {
        const written = writeKeysToEnv(
          process.cwd(),
          { anonKey, serviceKey },
          opts.force === true,
        )
        if (written.path === null) {
          error("No .env here to write to. Create one, or drop --write to print the keys.")
          process.exit(1)
        }
        plain(`\nKeys valid for ${expYears} years, written to ${written.path}:\n`)
        // The names come back from the writer rather than being restated here, which is the whole
        // point of there being one list.
        for (const key of written.written) plain(`  ${key}`)
        if (written.kept.length > 0) {
          plain(`\nLeft alone, because they already hold a value:\n`)
          for (const key of written.kept) plain(`  ${key}`)
          plain("\nRe-run with --force to replace them.")
        }
        plain("\nDo not commit .env to source control.")
        return
      }

      plain(`\nGenerated keys (valid for ${expYears} years):\n`)
      plain("ANON_KEY=" + anonKey)
      plain("SERVICE_ROLE_KEY=" + serviceKey)
      plain("\nAdd these to your .env file, or re-run with --write. Do not commit .env to source control.")
    })
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
    ...(apiUrl !== undefined && {
      VITE_SUPATYPE_URL: apiUrl,
      PUBLIC_SUPATYPE_URL: apiUrl,
      EXPO_PUBLIC_SUPATYPE_URL: apiUrl,
    }),
  }
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
  const apiUrl = existing["PUBLIC_SUPATYPE_URL"] || existing["API_EXTERNAL_URL"] || undefined
  const candidates = anonKeyEnvUpdates(keys.anonKey, keys.serviceKey, apiUrl)

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
 * rewrite the ANON_KEY / SERVICE_ROLE_KEY lines in that .env file in place.
 * Returns the minted pair, or null if no secret could be resolved.
 */
export function generateAndWriteKeys(
  dir: string,
  expYears = 10,
): { anonKey: string; serviceKey: string } | null {
  const secret = resolveSecret(dir)
  if (!secret) return null

  const { anonKey, serviceKey } = signKeyPair(secret, expYears)

  const envPath = resolve(dir, ".env")
  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf8")
    content = upsertEnvVar(content, "ANON_KEY", anonKey)
    content = upsertEnvVar(content, "SERVICE_ROLE_KEY", serviceKey)
    content = upsertEnvVar(content, "VITE_SUPATYPE_ANON_KEY", anonKey)
    content = upsertEnvVar(content, "PUBLIC_SUPATYPE_ANON_KEY", anonKey)
    content = upsertEnvVar(content, "EXPO_PUBLIC_SUPATYPE_ANON_KEY", anonKey)
    const apiUrl = readEnvVar(content, "PUBLIC_SUPATYPE_URL") ?? readEnvVar(content, "API_EXTERNAL_URL")
    if (apiUrl) {
      content = upsertEnvVar(content, "VITE_SUPATYPE_URL", apiUrl)
      content = upsertEnvVar(content, "EXPO_PUBLIC_SUPATYPE_URL", apiUrl)
    }
    writeFileSync(envPath, content, "utf8")
  }

  return { anonKey, serviceKey }
}

function upsertEnvVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m")
  if (re.test(content)) return content.replace(re, `${key}=${value}`)
  const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n"
  return `${content}${sep}${key}=${value}\n`
}

/** Whether `.env` declares `key` at all, with or without a value. */
function hasEnvLine(content: string, key: string): boolean {
  return new RegExp(`^${key}=`, "m").test(content)
}

function readEnvVar(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}=(.*)$`, "m")
  const match = re.exec(content)
  if (!match?.[1]) return undefined
  const value = match[1].trim()
  return value.length > 0 ? value : undefined
}

export function resolveSecret(dir: string = process.cwd()): string | undefined {
  // 1. Check environment variable
  const fromEnv = process.env["JWT_SECRET"]
  if (fromEnv) return fromEnv

  // 2. Parse .env file in the target directory
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return undefined

  try {
    const contents = readFileSync(envPath, "utf8")
    for (const line of contents.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("JWT_SECRET=")) {
        const value = trimmed.slice("JWT_SECRET=".length).trim()
        if (value && !value.startsWith("#")) return value
      }
    }
  } catch {
    // ignore read errors
  }
  return undefined
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
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return []

  const content = readFileSync(envPath, "utf8")
  const blank = (name: string): boolean => {
    const current = readEnvVar(content, name)
    return current === undefined || current.trim() === ""
  }

  const needed = ["ANON_KEY", "SERVICE_ROLE_KEY"].filter(blank)
  if (needed.length === 0) return []

  const secret = resolveSecret(dir)
  if (!secret) return []

  const { anonKey, serviceKey } = signKeyPair(secret, expYears)
  const minted: Record<string, string> = { ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceKey }

  let next = content
  for (const name of needed) {
    next = upsertEnvVar(next, name, minted[name] as string)
  }
  writeFileSync(envPath, next, "utf8")
  return needed
}
