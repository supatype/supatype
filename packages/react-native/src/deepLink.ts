import type { Session, SupatypeClient, SupatypeError } from "@supatype/client"

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

  const onUrl = (event: { url: string }): void => {
    void handleUrl(client, event.url, opts)
  }

  const subscription = opts.linking.addEventListener("url", onUrl)

  void opts.linking.getInitialURL().then((url) => {
    if (!active || url === null) return
    void handleUrl(client, url, opts)
  })

  return () => {
    active = false
    subscription.remove()
  }
}
