import { createClient } from "@supatype/client"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"
import { DEFAULT_COOKIE_PREFIX, parseSessionFromCookies, sessionCookie } from "./cookie-parser.js"
import type { CookieAdapter, ServerClientOptions } from "./types.js"

/**
 * A client for one server request, signed in as the session the request's cookies carry.
 *
 * It keeps no session of its own and runs no refresh timer: the cookie is the only store, and the
 * client lives as long as the request. A refresh happens only when a request it makes finds the
 * access token expired, and the rotated session goes back to the browser through `setAll`, so the
 * browser holds the new refresh token rather than the one the refresh just spent.
 */
export function createServerClient<TDatabase extends AnyDatabase = AnyDatabase>(
  url: string,
  anonKey: string,
  options: ServerClientOptions,
): SupatypeClient<TDatabase> {
  const prefix = options.cookiePrefix ?? DEFAULT_COOKIE_PREFIX
  const session = parseSessionFromCookies(options.cookies.getAll(), prefix)
  const client = createClient<TDatabase>({
    url,
    anonKey,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(session !== null && { initialSession: session }),
  })
  writeSessionChanges(client, options.cookies, prefix)
  return client
}

/**
 * Send every change to the client's session (a refresh, a sign-in, a sign-out) back to the browser
 * through the adapter's `setAll`, so the next request reads the new tokens rather than the old ones.
 */
function writeSessionChanges<TDatabase extends AnyDatabase>(
  client: SupatypeClient<TDatabase>,
  cookies: CookieAdapter,
  prefix: string,
): void {
  if (cookies.setAll === undefined) return
  // `onAuthStateChange` reports the current state as it subscribes: that is the cookie just read.
  let subscribed = false
  client.auth.onAuthStateChange((_event, next) => {
    if (!subscribed) return
    try {
      cookies.setAll?.([sessionCookie(next, prefix)])
    } catch {
      // A read-only cookie store (a Server Component) refuses the write; the session still works here.
    }
  })
  subscribed = true
}
