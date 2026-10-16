/**
 * Reading the auth server's redirect back to the app.
 *
 * The server returns a browser with the outcome in the URL: implicit-grant tokens in the fragment
 * (`#access_token=...&refresh_token=...`), a PKCE `code` in the query, or a refusal as `error`,
 * `error_code` and `error_description` in both. These helpers follow supabase-js: a URL is an auth
 * redirect when it carries `access_token` or `error_description`, or a `code` this client is
 * waiting for, and once read it loses those parameters so a reload or a shared link does not replay
 * them.
 */

import type { SupatypeError } from "./types.js"

/** Query parameters the server adds to the redirect; anything else is the app's own and is kept. */
const QUERY_KEYS = ["code", "error", "error_code", "error_description", "sb"] as const

/** Fragment parameters that mark the fragment as the server's rather than the app's (a hash route). */
const FRAGMENT_KEYS = ["access_token", "refresh_token", "error", "error_description", "sb"] as const

export interface RedirectParams {
  query: URLSearchParams
  fragment: URLSearchParams
}

/** The redirect's query and fragment parameters, or null when `href` is not a URL. */
export function redirectParams(href: string): RedirectParams | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
  return { query: url.searchParams, fragment: new URLSearchParams(hash) }
}

/** A parameter from the fragment or the query, as the server may put it in either. */
export function redirectParam(params: RedirectParams, key: string): string | null {
  const value = params.fragment.get(key) ?? params.query.get(key)
  return value === null || value === "" ? null : value
}

/** True when the URL carries implicit-grant tokens or the server's refusal. */
export function carriesImplicitResult(params: RedirectParams): boolean {
  return redirectParam(params, "access_token") !== null || redirectParam(params, "error_description") !== null
}

/** `href` without the parameters the server added, ready for `history.replaceState`. */
export function withoutAuthParams(href: string): string {
  const url = new URL(href)
  for (const key of QUERY_KEYS) url.searchParams.delete(key)
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (FRAGMENT_KEYS.some((key) => fragment.has(key))) url.hash = ""
  return url.toString()
}

/** The page's URL when running in a browser, else null (a server, a worker, React Native). */
export function browserHref(): string | null {
  if (typeof window === "undefined") return null
  const href: unknown = window.location?.href
  return typeof href === "string" ? href : null
}

/** Take the auth parameters out of the address bar without a navigation. */
export function cleanBrowserUrl(href: string): void {
  if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return
  window.history.replaceState(window.history.state, "", withoutAuthParams(href))
}

/** The part of `AuthClient` a binding starts an OAuth sign-in through. */
interface OAuthStarter {
  signInWithOAuth(opts: { provider: string }): Promise<{
    data: { url: string }
    error: SupatypeError | null
  }>
}

/**
 * Start an OAuth sign-in for a framework binding: ask the client for the provider's URL and send
 * the browser there, as supabase-js's `signInWithOAuth` does. A refusal (a provider the project has
 * not enabled) is returned and the page stays put.
 */
export async function startOAuthRedirect(
  auth: OAuthStarter,
  provider: string,
): Promise<{ error: SupatypeError | null }> {
  const { data, error } = await auth.signInWithOAuth({ provider })
  if (error === null && data.url !== "" && typeof window !== "undefined") window.location.assign(data.url)
  return { error }
}
