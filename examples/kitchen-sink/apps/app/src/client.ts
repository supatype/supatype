import { createClient } from "../../../supatype/generated/client"

/** A dev build's anon key, from `.env.development.local`. A production build has none. */
const devAnonKey: unknown = import.meta.env.VITE_SUPATYPE_ANON_KEY

/**
 * One origin for the app and its API.
 *
 * Supatype serves this build (`app.mode: "static"`), so the API is wherever the page came from.
 * The anon key is not built in: `supatype keys` and `dev` write the local stack's to
 * `.env.development.local`, which a production `vite build` never reads, so no build ships it.
 * `index.html` loads `/supatype-env.js` from the server that serves the page, and the client reads
 * the key from it at its first request, naming what is missing if it cannot. The gateway decides
 * what that key may read, and every rule doing so is in `schema/index.ts`.
 */
export const supatype = createClient({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:54480",
  anonKey: typeof devAnonKey === "string" ? devAnonKey : undefined,
})
