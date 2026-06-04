import { createClient } from "@supatype/client"
import type { Database } from "../supatype/generated/database"

/**
 * Supabucks is served by Supatype itself (app.mode: "static"), so the API lives
 * at the same origin as the page — no CORS, no hardcoded host. The anon key is
 * injected at build time (signed with the local dev secret).
 *
 * Typed with the generated `Database` (supatype/generated/database.ts), so
 * `supatype.from("customer")` knows its columns.
 */
export const supatype = createClient<Database>({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:18473",
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY as string,
})
