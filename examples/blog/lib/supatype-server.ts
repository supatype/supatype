import { createServerClient } from "@supatype/ssr"
import type { AugmentedDatabase } from "@supatype/client"
import { cookies } from "next/headers"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""
const cookiePrefix = process.env["SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<AugmentedDatabase>(url, anonKey, {
    cookiePrefix,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options ?? {}),
          )
        } catch {
          // setAll is called from Server Components which are read-only — safe to ignore
        }
      },
    },
  })
}
