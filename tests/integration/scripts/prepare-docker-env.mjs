#!/usr/bin/env node
/**
 * Seed tests/integration/.env with local CI Docker image tags before `supatype dev`.
 * Keys not listed here are preserved by later upsertEnvFile merges in the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const integrationDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const envPath = resolve(integrationDir, ".env")

const updates = {
  SUPATYPE_POSTGRES_IMAGE: process.env.SUPATYPE_POSTGRES_IMAGE ?? "supatype/postgres:ci-dev",
  SUPATYPE_ENGINE_IMAGE: process.env.SUPATYPE_ENGINE_IMAGE ?? "supatype/schema-engine:ci-dev",
  SUPATYPE_SERVER_IMAGE: process.env.SUPATYPE_SERVER_IMAGE ?? "supatype/server:local-dev",
  SUPATYPE_REALTIME_IMAGE: process.env.SUPATYPE_REALTIME_IMAGE ?? "supatype/realtime:ci-dev",
  SUPATYPE_CONTROL_PLANE_IMAGE: process.env.SUPATYPE_CONTROL_PLANE_IMAGE ?? "supatype/control-plane:ci-dev",
}

let existing = ""
if (existsSync(envPath)) {
  existing = readFileSync(envPath, "utf8")
}

const keys = new Set(Object.keys(updates))
const kept = existing
  .split("\n")
  .filter((line) => {
    const key = line.split("=")[0]?.trim()
    return key && line.includes("=") && !keys.has(key)
  })

const merged = [
  ...kept,
  ...Object.entries(updates).map(([k, v]) => `${k}=${v}`),
]
writeFileSync(envPath, `${merged.join("\n").trimEnd()}\n`, "utf8")
console.log("[integration] Wrote Docker image pins to .env:")
for (const [k, v] of Object.entries(updates)) {
  console.log(`  ${k}=${v}`)
}
