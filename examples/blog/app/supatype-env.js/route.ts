// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and
// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.
// No segment config: GET reads the request, which keeps it out of the build's prerender on every
// Next version, and Next 16 with cacheComponents refuses a `dynamic` export.
export { GET } from "@supatype/ssr/next"
