import { createServerClient } from "@supatype/ssr"
import type { AugmentedDatabase } from "@supatype/client"
import { cookies } from "next/headers"

const cookiePrefix = process.env["SUPATYPE_AUTH_COOKIE_PREFIX"] ?? "st"

/**
 * A client for the Server Components that render the blog. They cannot write cookies, so there is no
 * `setAll`, and without one the client never refreshes the session: a refresh would spend the
 * refresh token the browser holds and hand back one the browser never receives.
 *
 * Given no address or anon key, it reads SUPATYPE_URL and SUPATYPE_ANON_KEY from the server's
 * environment on each request: the same two /supatype-env.js serves the page, so one build runs
 * against whichever deployment it is started for. A NEXT_PUBLIC_ name here would be fixed into the
 * build instead.
 */
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<AugmentedDatabase>({
    cookiePrefix,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
    },
  })
}
