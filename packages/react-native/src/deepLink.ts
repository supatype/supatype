import type { Session, SupatypeClient, SupatypeError } from "@supatype/client"
import { reportThrown } from "@supatype/client/bindings"

export interface LinkingSubscription {
  remove(): void
}

/** Minimal React Native / Expo Linking surface. */
export interface LinkingLike {
  addEventListener(
    type: "url",
    handler: (event: { url: string }) => void,
  ): LinkingSubscription
  getInitialURL(): Promise<string | null>
}

export interface CreateAuthUrlListenerOptions {
  linking: LinkingLike
  /** Only process URLs that include this substring (e.g. `"auth/callback"`). */
  pathIncludes?: string | undefined
  onSession?: ((session: Session) => void) | undefined
  onError?: ((error: SupatypeError) => void) | undefined
}

type AuthCapable = Pick<SupatypeClient, "auth">

function urlMatches(url: string, pathIncludes: string | undefined): boolean {
  if (pathIncludes === undefined || pathIncludes === "") return true
  return url.includes(pathIncludes)
}

async function handleUrl(
  client: AuthCapable,
  url: string,
  opts: CreateAuthUrlListenerOptions,
): Promise<void> {
  if (!urlMatches(url, opts.pathIncludes)) return
  // Skip URLs that clearly aren't auth redirects.
  if (
    !url.includes("code=") &&
    !url.includes("access_token=") &&
    !url.includes("error=") &&
    !url.includes("error_description=")
  ) {
    return
  }

  const { data, error } = await client.auth.getSessionFromUrl(url)
  if (error !== null) {
    opts.onError?.(error)
    return
  }
  if (data.session !== null) {
    opts.onSession?.(data.session)
  }
}

/**
 * Listen for auth deep links (cold start + warm) and complete PKCE / implicit / error redirects.
 *
 * @returns Unsubscribe function.
 */
export function createAuthUrlListener(
  client: AuthCapable,
  opts: CreateAuthUrlListenerOptions,
): () => void {
  let active = true

  // A link that throws instead of answering (a client with no API address, say) still fails the
  // sign-in, so `onError` hears it rather than an unhandled rejection nobody is listening for.
  const thrown = (e: unknown): void => {
    opts.onError?.(reportThrown("createAuthUrlListener", e))
  }
  const onUrl = (event: { url: string }): void => {
    void handleUrl(client, event.url, opts).catch(thrown)
  }

  const subscription = opts.linking.addEventListener("url", onUrl)

  void opts.linking.getInitialURL().then((url) => {
    if (!active || url === null) return
    return handleUrl(client, url, opts)
  }).catch(thrown)

  return () => {
    active = false
    subscription.remove()
  }
}
