import type { Command } from "commander"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { signJwt } from "../jwt.js"
import { error, plain } from "../ui/messages.js"

export function registerKeys(program: Command): void {
  program
    .command("keys")
    .description("Generate ANON_KEY and SERVICE_ROLE_KEY JWTs from your JWT_SECRET")
    .option("--secret <secret>", "JWT secret (defaults to JWT_SECRET env var or value in .env)")
    .option("--exp-years <years>", "Token expiry in years (default: 10)", "10")
    .option("--force", "Overwrite ANON_KEY / SERVICE_ROLE_KEY that already hold a value")
    .action((opts: { secret?: string; expYears: string; force?: boolean }) => {
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

      plain(`\nGenerated keys (valid for ${expYears} years):\n`)
      plain("ANON_KEY=" + anonKey)
      plain("SERVICE_ROLE_KEY=" + serviceKey)
      plain("")

      const written = writeKeysToEnv(process.cwd(), { anonKey, serviceKey }, opts.force === true)
      if (written.path === null) {
        plain("No .env here. Add these to one, and do not commit it to source control.")
        return
      }
      if (written.names.length > 0) {
        plain(`Written to .env: ${written.names.join(", ")}.`)
      }
      if (written.skipped.length > 0) {
        plain(
          `Left alone in .env: ${written.skipped.join(", ")} (already set). ` +
            "Re-run with --force to replace them.",
        )
      }
      plain("Do not commit .env to source control.")
    })
}

/**
 * The env names each minted key is written to.
 *
 * The first is canonical and is always written; the rest are a front end's own spelling of the
 * same value, and are only updated when the project already declares them.
 */
const KEY_ALIASES = {
  anonKey: [
    "ANON_KEY",
    "VITE_SUPATYPE_ANON_KEY",
    "PUBLIC_SUPATYPE_ANON_KEY",
    "EXPO_PUBLIC_SUPATYPE_ANON_KEY",
  ],
  serviceKey: ["SERVICE_ROLE_KEY"],
} as const satisfies Record<"anonKey" | "serviceKey", readonly string[]>

export interface WriteKeysResult {
  /** The .env written, or null when there is none here to write. */
  path: string | null
  names: string[]
  skipped: string[]
}

/**
 * Write a minted pair into `dir`'s .env, filling blanks and leaving set values alone.
 *
 * This command printed the pair and wrote nothing, while every README in this repository says it
 * mints the keys into .env. Following the docs therefore produced a front end built with
 * `anonKey: undefined` and a gateway refusing its every request, with nothing in the output
 * saying so.
 *
 * Blanks only by default, for the reason {@link fillMissingKeys} gives: an anon key already in
 * use is held by clients this command cannot reach, and silently reissuing it locks them out.
 * `--force` is how someone says they meant to rotate.
 */
export function writeKeysToEnv(
  dir: string,
  keys: { anonKey: string; serviceKey: string },
  force: boolean,
): WriteKeysResult {
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return { path: null, names: [], skipped: [] }

  let content = readFileSync(envPath, "utf8")
  const names: string[] = []
  const skipped: string[] = []

  for (const key of ["anonKey", "serviceKey"] as const) {
    for (const [index, name] of KEY_ALIASES[key].entries()) {
      // Presence of the line, not of a value: an alias declared and left blank is exactly the
      // one to fill, and `readEnvVar` reports blank as undefined, so it cannot answer this.
      if (index > 0 && !hasEnvLine(content, name)) continue
      const current = readEnvVar(content, name)
      if (current !== undefined && !force) {
        skipped.push(name)
        continue
      }
      content = upsertEnvVar(content, name, keys[key])
      names.push(name)
    }
  }

  if (names.length > 0) writeFileSync(envPath, content, "utf8")
  return { path: envPath, names, skipped }
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
