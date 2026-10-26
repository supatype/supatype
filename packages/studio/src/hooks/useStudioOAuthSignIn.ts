"use client"

import type { SupatypeClient } from "@supatype/client"
import { useCallback, useEffect, useState } from "react"
import { browserNavigation } from "../lib/browser-navigation.js"
import { injectedRuntimeConfig } from "../lib/runtime-config.js"
import { fetchSignInSettings, studioSignInProviders } from "../lib/studio-sign-in.js"

export interface StudioOAuthSignIn {
  /** The OAuth providers Studio offers (see `studioSignInProviders`). Empty until they are read. */
  providers: readonly string[]
  /** Why the sign-in the page's URL carried was refused, or null. */
  redirectError: string | null
  /** Leave for the provider; the auth server brings the browser back to Studio. */
  signInWithProvider(provider: string): Promise<{ error: string | null }>
}

/** The project's enabled providers, narrowed by `studio.auth.providers`. Empty when unreadable. */
function useSignInProviders(apiBaseUrl: string, anonKey: string): string[] {
  const [providers, setProviders] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    const narrowedTo = injectedRuntimeConfig().authProviders
    // Password sign-in still works when the settings cannot be read; it just offers no providers.
    const read = fetchSignInSettings(apiBaseUrl, anonKey).then(
      (settings) => studioSignInProviders(settings, narrowedTo),
      () => [],
    )
    void read.then((found) => {
      if (!cancelled) setProviders(found)
    })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, anonKey])
  return providers
}

/** The refusal the client found when it finished the sign-in in the page's URL, if any. */
function useRedirectError(authClient: SupatypeClient): string | null {
  const [redirectError, setRedirectError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void authClient.auth.initialize().then(({ error }) => {
      if (!cancelled && error !== null) setRedirectError(error.message)
    })
    return () => {
      cancelled = true
    }
  }, [authClient])
  return redirectError
}

/**
 * Sign in to Studio with one of the project's OAuth providers.
 *
 * PKCE, so the session never sits in the URL, and flagged `studio=1`, so the auth server returns
 * the browser to its own Studio address whatever the project's site URL is. The client finishes
 * the sign-in when Studio loads with the code; the access gate then checks for a Studio role as it
 * does after a password sign-in.
 */
export function useStudioOAuthSignIn(apiBaseUrl: string, anonKey: string, authClient: SupatypeClient): StudioOAuthSignIn {
  const providers = useSignInProviders(apiBaseUrl, anonKey)
  const redirectError = useRedirectError(authClient)
  const signInWithProvider = useCallback(
    async (provider: string) => {
      const { data, error } = await authClient.auth.signInWithOAuth({
        provider,
        options: { flowType: "pkce", queryParams: { studio: "1" } },
      })
      if (error !== null) return { error: error.message }
      browserNavigation.assign(data.url)
      return { error: null }
    },
    [authClient],
  )
  return { providers, redirectError, signInWithProvider }
}
