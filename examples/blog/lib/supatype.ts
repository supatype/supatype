import { createClient } from "../supatype/generated/client"
// Undefined when the build had none: the client then reads the values /supatype-env.js sets
// (app/supatype-env.js/route.ts, loaded by the root layout) at its first request. A default here
// would win over those, and send a deployed page to localhost.
const url = process.env["NEXT_PUBLIC_SUPATYPE_URL"]
const anonKey = process.env["NEXT_PUBLIC_SUPATYPE_ANON_KEY"]
const cookiePrefix = process.env["NEXT_PUBLIC_SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

export const supatype = createClient({
  url,
  anonKey,
  auth: { cookiePrefix },
})
