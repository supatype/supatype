#!/usr/bin/env node
/**
 * Write a `.env` with the secrets and JWT keys self-host compose needs (CI smoke + local).
 * Mirrors packages/cli/src/dev-compose.ts ensureDevComposeEnv().
 *
 * Usage: ensure-compose-env.mjs [project-dir]
 *
 * Defaults to tests/integration. The argument exists because more than one project needs these:
 * examples/validation runs the same compose stack, and hand-rolling a second copy of the secret
 * list there missed AUTHENTICATOR_PASSWORD, which compose refuses to interpolate without.
 *
 * Run after `pnpm build` (imports packages/cli/dist/jwt.js).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { signJwt } from "../../../packages/cli/dist/jwt.js"

const integrationDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const targetDir = process.argv[2] ? resolve(process.argv[2]) : integrationDir
const envPath = resolve(targetDir, ".env")

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"
const kongPort = Number(process.env.SUPATYPE_KONG_PORT ?? process.env.COMPOSE_KONG_PORT ?? 18473)
const apiUrl = process.env.API_EXTERNAL_URL ?? `http://localhost:${kongPort}`

const now = Math.floor(Date.now() / 1000)
const jwtBase = { iss: "supatype", iat: now, exp: now + 315_360_000 }
const anonKey = signJwt({ ...jwtBase, role: "anon" }, JWT_SECRET)
const serviceRoleKey = signJwt({ ...jwtBase, role: "service_role" }, JWT_SECRET)

const updates = {
  POSTGRES_USER: "supatype_admin",
  POSTGRES_PASSWORD: "postgres",
  POSTGRES_DB: "supatype",
  // The generator deliberately never invents this: the authenticator role is the operator's to
  // create, so the compose file interpolates it as required with no default. A fixture is the
  // operator here, so it supplies its own, the stack does not start without it.
  AUTHENTICATOR_PASSWORD: "authenticator-ci-password",
  JWT_SECRET,
  ANON_KEY: anonKey,
  SERVICE_ROLE_KEY: serviceRoleKey,
  PUBLIC_SUPATYPE_ANON_KEY: anonKey,
  PUBLIC_SUPATYPE_URL: apiUrl,
  SUPATYPE_KONG_PORT: String(kongPort),
  API_EXTERNAL_URL: apiUrl,
  SITE_URL: apiUrl,
  SUPATYPE_MAILER_AUTOCONFIRM: "true",
}

const keys = new Set(Object.keys(updates))
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
const kept = existing
  .split("\n")
  .filter((line) => {
    const key = line.split("=")[0]?.trim()
    return key && line.includes("=") && !keys.has(key)
  })

writeFileSync(
  envPath,
  `${[...kept, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`)].join("\n").trimEnd()}\n`,
  "utf8",
)

console.log(`[ensure-compose-env] Wrote ${envPath} (Kong :${kongPort})`)
