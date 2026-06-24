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
    .action((opts: { secret?: string; expYears: string }) => {
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

      const now = Math.floor(Date.now() / 1000)
      const exp = now + expYears * 365 * 24 * 60 * 60

      const anonKey = signJwt({ iss: "supatype", role: "anon", iat: now, exp }, secret)
      const serviceKey = signJwt({ iss: "supatype", role: "service_role", iat: now, exp }, secret)

      plain(`\nGenerated keys (valid for ${expYears} years):\n`)
      plain("ANON_KEY=" + anonKey)
      plain("SERVICE_ROLE_KEY=" + serviceKey)
      plain("\nAdd these to your .env file. Do not commit .env to source control.")
    })
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
