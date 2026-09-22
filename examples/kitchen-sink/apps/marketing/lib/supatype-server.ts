import { createServerClient } from "@supatype/ssr"
import { cookies } from "next/headers"
import type { Database } from "../../../supatype/generated/database"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""
const cookiePrefix = process.env["SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

/**
 * A client that reads the caller's session off the request's cookies.
 *
 * This is the whole reason the marketing half is a server-rendered app rather than a second SPA: an
 * editor previewing an unpublished page and a reader seeing only what is live are the same code
 * path, distinguished by who the request is from. A static build cannot make that distinction.
 */
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
    cookiePrefix,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options ?? {}))
        } catch {
          // Server Components are read-only; a refresh written here is picked up by middleware.
        }
      },
    },
  })
}
