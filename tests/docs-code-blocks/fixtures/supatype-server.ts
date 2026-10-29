/**
 * The reader's server client module from the Next.js example, imported as `@/supatype-server`.
 * The real one builds a cookie-aware client with @supatype/ssr; a plain client has the same
 * query API, which is all the examples use.
 */
import { createClient } from "@supatype/client"

export async function serverClient() {
  return createClient({ url: "http://localhost:54321", anonKey: "anon-key" })
}
