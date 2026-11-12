import { createClient } from "../supatype/generated/client"

/** A dev server's anon key, from `.env.development.local`. A production build has none. */
const devAnonKey: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY

/**
 * One client, shared by all three apps.
 *
 * Deliberately not three: the bindings differ, the client does not, and putting it here keeps the
 * per-framework files down to the part worth comparing.
 *
 * The anon key is not built in: each app's `index.html` loads `/supatype-env.js` from the server
 * that serves the page (the gateway, or the dev server's proxy to it), and the client reads the key
 * from it at its first request. So a plain `vite build` never ships the local stack's key.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54490",
  anonKey: typeof devAnonKey === "string" ? devAnonKey : undefined,
})
