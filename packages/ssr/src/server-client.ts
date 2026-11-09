import { createClient } from "@supatype/client"
import type { SupatypeClient, AnyDatabase } from "@supatype/client"
import { DEFAULT_COOKIE_PREFIX, parseSessionFromCookies, sessionCookie } from "./cookie-parser.js"
import { SERVER_ANON_KEY_NAMES, SERVER_URL_NAMES, serverEnv } from "./server-env.js"
import type { CookieAdapter, ServerClientOptions } from "./types.js"

/**
 * A client for one server request, signed in as the session the request's cookies carry.
 *
 * It keeps no session of its own and runs no refresh timer: the cookie is the only store, and the
 * client lives as long as the request. With `setAll`, a refresh happens only when a request it
 * makes finds the access token expired, and the rotated session goes back to the browser through
 * `setAll`, so the browser holds the new refresh token rather than the one the refresh just spent.
 *
 * Without `setAll` (a Server Component) it never refreshes: an expired access token is sent as it
 * is and refused. A refresh there would spend the browser's refresh token and return one the
 * browser never receives, so the browser's own next refresh would be refused and sign it out.
 *
 * The address and anon key default to `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` from the server's
 * environment, read now: pass only the options, or `undefined` for either. These are the same two
 * variables `@supatype/ssr/next` serves to the page. Where one is unset, `NEXT_PUBLIC_SUPATYPE_URL`
 * or `NEXT_PUBLIC_SUPATYPE_ANON_KEY` is used instead. With none given or set, the client's first
 * request throws the error naming them.
 */
export function createServerClient<TDatabase extends AnyDatabase = AnyDatabase>(
  options: ServerClientOptions,
): SupatypeClient<TDatabase>
export function createServerClient<TDatabase extends AnyDatabase = AnyDatabase>(
  url: string | undefined,
  anonKey: string | undefined,
  options: ServerClientOptions,
): SupatypeClient<TDatabase>
export function createServerClient<TDatabase extends AnyDatabase = AnyDatabase>(
  ...args: [ServerClientOptions] | [string | undefined, string | undefined, ServerClientOptions]
): SupatypeClient<TDatabase> {
  const [url, anonKey, options] = args.length === 1 ? [undefined, undefined, args[0]] : args
  const prefix = options.cookiePrefix ?? DEFAULT_COOKIE_PREFIX
  const session = parseSessionFromCookies(options.cookies.getAll(), prefix)
  const client = createClient<TDatabase>({
    url: givenOrServerEnv(url, SERVER_URL_NAMES),
    anonKey: givenOrServerEnv(anonKey, SERVER_ANON_KEY_NAMES),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      refreshExpiredToken: options.cookies.setAll !== undefined,
      detectSessionInUrl: false,
    },
    ...(session !== null && { initialSession: session }),
  })
  writeSessionChanges(client, options.cookies, prefix)
  return client
}

/** The value given, unless it is missing or blank, else the first of the server's `names` that is set. */
function givenOrServerEnv(given: string | undefined, names: readonly string[]): string | undefined {
  if (given !== undefined && given.trim() !== "") return given
  for (const name of names) {
    const value = serverEnv(name)
    if (value !== undefined) return value
  }
  return undefined
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
      // The cookie store refused the write; the session still works for this request. Where cookies
      // are read-only (a Server Component), `setAll` is left out and the client does not refresh.
    }
  })
  subscribed = true
}
