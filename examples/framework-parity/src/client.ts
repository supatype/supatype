import { createClient } from "@supatype/client"
import type { Database } from "../supatype/generated/database"

/**
 * One client, shared by all three apps.
 *
 * Deliberately not three: the bindings differ, the client does not, and putting it here keeps the
 * per-framework files down to the part worth comparing.
 */
export const supatype = createClient<Database>({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54490",
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY as string,
})
