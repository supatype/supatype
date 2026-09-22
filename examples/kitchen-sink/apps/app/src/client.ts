import { createClient } from "@supatype/client"
import type { Database } from "../../../supatype/generated/database"

/**
 * One origin for the app and its API.
 *
 * Supatype serves this build (`app.mode: "static"`), so the API is wherever the page came from.
 * The anon key is injected at build time; the gateway is what decides what that key may read, and
 * every rule doing so is in `schema/index.ts`.
 */
export const supatype = createClient<Database>({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54480",
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY as string,
})
