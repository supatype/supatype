import { createClient } from "@supatype/client"

function getContentEnv(name: string): string {
  if (typeof process !== "undefined" && process.env?.[name]) {
    return process.env[name]!
  }
  if (typeof import.meta !== "undefined") {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env
    if (env?.[name]) return env[name]
  }
  return ""
}

/**
 * Supatype client configured for the supatype-content project.
 * Intended for build-time use only (SSG data fetching).
 */
export const contentClient = createClient({
  url: getContentEnv("CONTENT_PROJECT_URL"),
  anonKey: getContentEnv("CONTENT_ANON_KEY"),
})
