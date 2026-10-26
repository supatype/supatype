import { createClient } from "@supatype/client"
import { importMetaEnv } from "./build-env.js"

declare const process: { env?: Record<string, string | undefined> } | undefined

function getContentEnv(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env?.[name]) {
    return proc.env[name]!
  }
  return importMetaEnv(name) ?? ""
}

/**
 * Supatype client configured for the supatype-content project.
 * Intended for build-time use only (SSG data fetching).
 */
export const contentClient = createClient({
  url: getContentEnv("CONTENT_PROJECT_URL"),
  anonKey: getContentEnv("CONTENT_ANON_KEY"),
})
