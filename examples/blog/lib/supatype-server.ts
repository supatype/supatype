import { createServerClient } from "@supatype/ssr"
import type { AugmentedDatabase } from "@supatype/client"
import { cookies } from "next/headers"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""
const cookiePrefix = process.env["SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

/**
 * A client for the Server Components that render the blog. They cannot write cookies, so there is no
 * `setAll`, and without one the client never refreshes the session: a refresh would spend the
 * refresh token the browser holds and hand back one the browser never receives.
 */
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<AugmentedDatabase>(url, anonKey, {
    cookiePrefix,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
    },
  })
}
