"use client"

import { useState, useEffect } from "react"
import type { Session, User, AuthChangeEvent, AuthRedirectError, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseAuthReturn {
  /** The currently authenticated user, or null if not signed in. */
  user: User | null
  /** The current session (includes access token), or null. */
  session: Session | null
  /**
   * True while loading the initial auth state, which includes finishing a sign-in the page's URL
   * carries (an OAuth or email-link redirect).
   */
  loading: boolean
  /** The sign-in the auth server refused and reported in the page's URL, or null. */
  error: AuthRedirectError | null
  /** Sign up with email and password. */
  signUp(credentials: {
    email: string
    password: string
    options?: { data?: Record<string, unknown> } | undefined
  }): Promise<{ data: { session: Session | null; user: User | null }; error: SupatypeError | null }>
  /** Sign in with email and password. */
  signIn(credentials: {
    email: string
    password: string
  }): Promise<{ data: { session: Session | null; user: User | null }; error: SupatypeError | null }>
  /** Sign in via OAuth provider (returns redirect URL). */
  signInWithOAuth(opts: {
    provider: string
    options?: { redirectTo?: string } | undefined
  }): Promise<{ data: { url: string; provider: string }; error: SupatypeError | null }>
  /** Sign in with a magic link (OTP) sent to the email. */
  signInWithOtp(opts: {
    email: string
    options?: { emailRedirectTo?: string } | undefined
  }): Promise<{ data: { messageId?: string | undefined }; error: SupatypeError | null }>
  /** Sign out the current user. */
  signOut(): Promise<{ error: SupatypeError | null }>
}

/**
 * Access auth state and methods. Must be used inside a <SupatypeProvider>.
 *
 * @example
 * ```tsx
 * function LoginButton() {
 *   const { user, signIn, signOut } = useAuth()
 *   if (user) return <button onClick={signOut}>Sign out</button>
 *   return <button onClick={() => signIn({ email, password })}>Sign in</button>
 * }
 * ```
 */
export function useAuth(): UseAuthReturn {
  const client = useSupatype()
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AuthRedirectError | null>(null)

  useEffect(() => {
    let active = true
    // Seed once the client has started: the stored session, or the one the page's URL carried.
    void client.auth.initialize().then(async ({ error: redirectError }) => {
      const { data } = await client.auth.getSession()
      if (!active) return
      setSession(data.session)
      setError(redirectError)
      setLoading(false)
    })

    // Subscribe to future changes
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (_event: AuthChangeEvent, newSession: Session | null) => setSession(newSession),
    )

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [client])

  return {
    user: session?.user ?? null,
    session,
    loading,
    error,
    signUp: (creds) => client.auth.signUp(creds),
    signIn: (creds) => client.auth.signInWithPassword(creds),
    signInWithOAuth: (opts) => client.auth.signInWithOAuth(opts),
    signInWithOtp: (opts) => client.auth.signInWithOtp(opts),
    signOut: () => client.auth.signOut(),
  }
}
