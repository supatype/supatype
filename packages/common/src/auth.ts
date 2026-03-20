import { createClient } from "@supatype/client"
import { config } from "./config.js"

export interface PlatformUser {
  name: string
  email: string
  avatar?: string
}

/** Supatype client initialised with the platform project's URL and anon key. */
export const platformClient = createClient({
  url: config.platformUrl,
  anonKey: config.platformAnonKey,
})

/** Read the st-platform-user cookie for display info. */
export function getPlatformUser(): PlatformUser | null {
  if (typeof document === "undefined") return null
  const cookie = document.cookie
    .split("; ")
    .find((c) => c.startsWith("st-platform-user="))
  if (!cookie) return null
  try {
    return JSON.parse(decodeURIComponent(cookie.split("=")[1]!)) as PlatformUser
  } catch {
    return null
  }
}
