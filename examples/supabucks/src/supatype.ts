import { createClient } from "../supatype/generated/client"
import type { Database } from "../supatype/generated/database"

/** The anon key Vite injects at build time. Read through here so a build without it says so. */
function anonKey(): string {
  const key: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY
  if (typeof key !== "string" || key === "") {
    throw new Error("VITE_SUPATYPE_ANON_KEY is not set: add it to .env before building the app")
  }
  return key
}

/**
 * Supabucks is served by Supatype itself (app.mode: "static"), so the API lives
 * at the same origin as the page, no CORS, no hardcoded host. The anon key is
 * injected at build time (signed with the local dev secret).
 *
 * Typed with the generated `Database` (supatype/generated/database.ts), so
 * `supatype.from("customer")` knows its columns.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:18473",
  anonKey: anonKey(),
})
