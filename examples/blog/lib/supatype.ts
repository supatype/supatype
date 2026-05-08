import { createClient } from "@supatype/client"
import type { AugmentedDatabase } from "@supatype/client"

const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? "http://localhost:18473"
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"] ?? ""
const cookiePrefix = process.env["NEXT_PUBLIC_SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

export const supatype = createClient<AugmentedDatabase>({
  url,
  anonKey,
  auth: { cookiePrefix },
})
