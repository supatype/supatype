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
    const user = JSON.parse(decodeURIComponent(cookie.split("=")[1]!))
    return isPlatformUser(user) ? user : null
  } catch {
    return null
  }
}

/** The cookie's value, when it has the name and email this reads, and an avatar only as text. */
function isPlatformUser(value: unknown): value is PlatformUser {
  if (typeof value !== "object" || value === null) return false
  if (!("name" in value) || !("email" in value)) return false
  const avatarIsTextOrAbsent = !("avatar" in value) || value.avatar === undefined || typeof value.avatar === "string"
  return typeof value.name === "string" && typeof value.email === "string" && avatarIsTextOrAbsent
}
