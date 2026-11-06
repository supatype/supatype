// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and
// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.
export { GET } from "@supatype/ssr/next"
// Written here rather than re-exported: Next reads a route's segment config from this file only.
export const dynamic = "force-dynamic"
