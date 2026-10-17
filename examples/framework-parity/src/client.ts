import { createClient } from "../supatype/generated/client"

/** The anon key Vite injects at build time. Read through here so a build without it says so. */
function anonKey(): string {
  const key: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY
  if (typeof key !== "string" || key === "") {
    throw new Error("VITE_SUPATYPE_ANON_KEY is not set: add it to .env before building the app")
  }
  return key
}

/**
 * One client, shared by all three apps.
 *
 * Deliberately not three: the bindings differ, the client does not, and putting it here keeps the
 * per-framework files down to the part worth comparing.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54490",
  anonKey: anonKey(),
})
