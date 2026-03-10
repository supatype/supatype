import type { Command } from "commander"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { signJwt } from "../jwt.js"

export function registerKeys(program: Command): void {
  program
    .command("keys")
    .description("Generate ANON_KEY and SERVICE_ROLE_KEY JWTs from your JWT_SECRET")
    .option("--secret <secret>", "JWT secret (defaults to JWT_SECRET env var or value in .env)")
    .option("--exp-years <years>", "Token expiry in years (default: 10)", "10")
    .action((opts: { secret?: string; expYears: string }) => {
      const secret = opts.secret ?? resolveSecret()
      if (!secret) {
        console.error(
          "Error: JWT_SECRET not found. Set it in .env or pass --secret <value>",
        )
        process.exit(1)
      }

      const expYears = parseInt(opts.expYears, 10)
      if (isNaN(expYears) || expYears < 1) {
        console.error("Error: --exp-years must be a positive integer")
        process.exit(1)
      }

      const now = Math.floor(Date.now() / 1000)
      const exp = now + expYears * 365 * 24 * 60 * 60

      const anonKey = signJwt({ iss: "supatype", role: "anon", iat: now, exp }, secret)
      const serviceKey = signJwt({ iss: "supatype", role: "service_role", iat: now, exp }, secret)

      console.log("\nGenerated keys (valid for", expYears, "years):\n")
      console.log("ANON_KEY=" + anonKey)
      console.log("SERVICE_ROLE_KEY=" + serviceKey)
      console.log(
        "\nAdd these to your .env file. Do not commit .env to source control.",
      )
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function resolveSecret(): string | undefined {
  // 1. Check environment variable
  const fromEnv = process.env["JWT_SECRET"]
  if (fromEnv) return fromEnv

  // 2. Parse .env file in cwd
  const envPath = resolve(process.cwd(), ".env")
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
