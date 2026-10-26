/**
 * Resolve the project API base URL (Kong gateway or direct server) for CLI HTTP calls.
 */

import { loadConfig, rethrowIfConfigBroken } from "./config.js"
import { readComposeEnvInt, readEnvValue } from "./env-file.js"
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

  // As compose binds it: an exported SUPATYPE_KONG_PORT first, then `.env`.
  const kongPort = readComposeEnvInt(cwd, "SUPATYPE_KONG_PORT")
  if (kongPort !== null) {
    return `http://localhost:${kongPort}`
  }

  try {
    const fromConfig = serverBaseUrl(loadConfig(cwd))
    if (fromConfig) {
      return fromConfig.replace(/\/+$/, "")
    }
  } catch (err) {
    rethrowIfConfigBroken(err)
    // No supatype.config: fall through to PORT default.
  }

  const port = readEnvValue(cwd, "PORT", "54321").trim() || "54321"
  return `http://localhost:${port}`
}
