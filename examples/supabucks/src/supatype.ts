import { createClient } from "../supatype/generated/client"

/** A dev build's anon key, from `.env.development.local`. A production build has none. */
const devAnonKey: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY

/**
 * Supabucks is served by Supatype itself (app.mode: "static"), so the API lives
 * at the same origin as the page, no CORS, no hardcoded host. The anon key is
 * not built in: `index.html` loads `/supatype-env.js` from the server that
 * serves the page, and the client reads the key from it at its first request.
 * So a plain `vite build` runs on whichever stack serves it, and never ships
 * the local stack's key.
 *
 * Typed by the generated client (supatype/generated/client.ts), which
 * declares the schema's models to `@supatype/client`, so
 * `supatype.from("customer")` knows its columns.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:18473",
  anonKey: typeof devAnonKey === "string" ? devAnonKey : undefined,
})
