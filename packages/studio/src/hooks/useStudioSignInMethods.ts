"use client"

import { ssoDomain, type SupatypeClient } from "@supatype/client"
import { useCallback, useEffect, useState } from "react"
import { browserNavigation } from "../lib/browser-navigation.js"
import { injectedRuntimeConfig } from "../lib/runtime-config.js"
import { fetchSignInSettings, PASSWORD_ONLY, studioSignInMethods, type StudioSignInMethods } from "../lib/studio-sign-in.js"

export interface StudioExternalSignIn {
  /** The ways the page offers (see `studioSignInMethods`). Email and password until they are read. */
  methods: StudioSignInMethods
  /** Why the sign-in the page's URL carried was refused, or null. */
  redirectError: string | null
  /** Leave for the OAuth provider; the auth server brings the browser back to Studio. */
  signInWithProvider(provider: string): Promise<{ error: string | null }>
  /** Leave for the SAML identity provider of the email's domain; it comes back the same way. */
  signInWithSSO(email: string): Promise<{ error: string | null }>
}

/** The project's sign-in methods, providers narrowed by `studio.auth.providers`. */
function useSignInMethods(apiBaseUrl: string, anonKey: string): StudioSignInMethods {
  const [methods, setMethods] = useState<StudioSignInMethods>(PASSWORD_ONLY)
  useEffect(() => {
    let cancelled = false
    const narrowedTo = injectedRuntimeConfig().authProviders
    // Password sign-in is still offered when the settings cannot be read; the server decides.
    const read = fetchSignInSettings(apiBaseUrl, anonKey).then(
      (settings) => studioSignInMethods(settings, narrowedTo),
      () => PASSWORD_ONLY,
    )
    void read.then((found) => {
      if (!cancelled) setMethods(found)
    })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, anonKey])
  return methods
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

/** Send the browser to a sign-in URL, or report why there is none. */
function leaveFor(result: { data: { url: string }; error: { message: string } | null }): { error: string | null } {
  if (result.error !== null) return { error: result.error.message }
  browserNavigation.assign(result.data.url)
  return { error: null }
}

/**
 * Sign in to Studio with one of the project's OAuth providers or its SAML single sign-on.
 *
 * PKCE, so the session never sits in the URL, and flagged for Studio (`studio=1` on `/authorize`,
 * `studio: true` on `/sso`), so the auth server returns the browser to its own Studio address
 * whatever the project's site URL is. The client finishes the sign-in when Studio loads with the
 * code; the access gate then checks for a Studio role as it does after a password sign-in.
 */
export function useStudioSignInMethods(apiBaseUrl: string, anonKey: string, authClient: SupatypeClient): StudioExternalSignIn {
  const methods = useSignInMethods(apiBaseUrl, anonKey)
  const redirectError = useRedirectError(authClient)
  const signInWithProvider = useCallback(
    async (provider: string) =>
      leaveFor(await authClient.auth.signInWithOAuth({ provider, options: { flowType: "pkce", queryParams: { studio: "1" } } })),
    [authClient],
  )
  const signInWithSSO = useCallback(
    async (email: string) => {
      const domain = ssoDomain(email)
      if (domain === null) return { error: "Enter your work email address, such as you@company.com." }
      return leaveFor(await authClient.auth.signInWithSSO({ domain, options: { studio: true, skipBrowserRedirect: true } }))
    },
    [authClient],
  )
  return { methods, redirectError, signInWithProvider, signInWithSSO }
}
