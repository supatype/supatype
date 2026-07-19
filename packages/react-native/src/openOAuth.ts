import type {
  AuthFlowType,
  Session,
  SupatypeClient,
  SupatypeError,
  User,
} from "@supatype/client"

/** Minimal expo-web-browser surface used by openOAuth. */
export interface WebBrowserLike {
  openAuthSessionAsync(
    url: string,
    redirectUrl?: string,
  ): Promise<{ type: string; url?: string }>
}

export interface OpenOAuthOptions {
  provider: string
  /** Deep-link URI registered with the auth server allowlist (e.g. `myapp://auth/callback`). */
  redirectTo: string
  scopes?: string | undefined
  /**
   * OAuth redirect flow. Default: `"pkce"` (recommended for mobile).
   * Pass `"implicit"` only if you need hash-token redirects.
   */
  flowType?: AuthFlowType | undefined
  /** Inject `expo-web-browser` (required unless provided via dependency injection in tests). */
  webBrowser: WebBrowserLike
}

export interface OpenOAuthResult {
  data: { session: Session | null; user: User | null }
  error: SupatypeError | null
  /** True when the user dismissed / cancelled the browser session. */
  cancelled: boolean
}

type AuthCapable = Pick<SupatypeClient, "auth">

/**
 * Start an in-app OAuth session (PKCE by default) and exchange the redirect for a session.
 *
 * @example
 * ```ts
 * import * as WebBrowser from "expo-web-browser"
 * import * as Linking from "expo-linking"
 * import { openOAuth } from "@supatype/react-native"
 *
 * const redirectTo = Linking.createURL("auth/callback")
 * const { data, error, cancelled } = await openOAuth(client, {
 *   provider: "google",
 *   redirectTo,
 *   webBrowser: WebBrowser,
 * })
 * ```
 */
export async function openOAuth(
  client: AuthCapable,
  opts: OpenOAuthOptions,
): Promise<OpenOAuthResult> {
  const flowType = opts.flowType ?? "pkce"
  const { data: oauth, error: oauthError } = await client.auth.signInWithOAuth({
    provider: opts.provider,
    options: {
      redirectTo: opts.redirectTo,
      flowType,
      ...(opts.scopes !== undefined && { scopes: opts.scopes }),
    },
  })

  if (oauthError !== null) {
    return { data: { session: null, user: null }, error: oauthError, cancelled: false }
  }

  const result = await opts.webBrowser.openAuthSessionAsync(oauth.url, opts.redirectTo)

  if (result.type !== "success" || result.url === undefined || result.url === "") {
    return { data: { session: null, user: null }, error: null, cancelled: true }
  }

  const { data, error } = await client.auth.getSessionFromUrl(result.url)
  return { data, error, cancelled: false }
}
