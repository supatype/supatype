import { createServerClient } from "@supatype/ssr"
import { cookies } from "next/headers"
import type { Database } from "@/types/database"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
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
