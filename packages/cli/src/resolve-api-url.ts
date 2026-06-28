/**
 * Resolve the project API base URL (Kong gateway or direct server) for CLI HTTP calls.
 */

import { loadConfig } from "./config.js"
import { readEnvValue } from "./env-file.js"
import { serverBaseUrl } from "./project-config.js"

const API_URL_ENV_KEYS = [
  "SUPATYPE_URL",
  "SUPATYPE_API_URL",
  "PUBLIC_SUPATYPE_URL",
  "NEXT_PUBLIC_SUPATYPE_URL",
  "SITE_URL",
  "API_EXTERNAL_URL",
] as const

/** Kong or server origin without a trailing slash. */
export function resolveProjectApiUrl(cwd: string): string {
  for (const key of API_URL_ENV_KEYS) {
    const value = readEnvValue(cwd, key, "").trim()
    if (value) {
      return value.replace(/\/+$/, "")
    }
  }

  const kongPort = readEnvValue(cwd, "SUPATYPE_KONG_PORT", "").trim()
  if (kongPort) {
    return `http://localhost:${kongPort}`
  }

  try {
    const fromConfig = serverBaseUrl(loadConfig(cwd))
    if (fromConfig) {
      return fromConfig.replace(/\/+$/, "")
    }
  } catch {
    // No supatype.config — fall through to PORT default.
  }

  const port = readEnvValue(cwd, "PORT", "54321").trim() || "54321"
  return `http://localhost:${port}`
}
