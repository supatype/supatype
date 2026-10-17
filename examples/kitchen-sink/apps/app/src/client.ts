import { createClient } from "../../../supatype/generated/client"

/** The anon key Vite injects at build time. Read through here so a build without it says so. */
function anonKey(): string {
  const key: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY
  if (typeof key !== "string" || key === "") {
    throw new Error("VITE_SUPATYPE_ANON_KEY is not set: add it to .env before building the app")
  }
  return key
}

/**
 * One origin for the app and its API.
 *
 * Supatype serves this build (`app.mode: "static"`), so the API is wherever the page came from.
 * The anon key is injected at build time; the gateway is what decides what that key may read, and
 * every rule doing so is in `schema/index.ts`.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54480",
  anonKey: anonKey(),
})
