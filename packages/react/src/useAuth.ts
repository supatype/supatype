import { useState, useEffect } from "react"
import type { Session, User, AuthChangeEvent, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseAuthReturn {
  /** The currently authenticated user, or null if not signed in. */
  user: User | null
  /** The current session (includes access token), or null. */
  session: Session | null
  /** True while loading the initial auth state. */
  loading: boolean
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
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Seed from current session
    void client.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    // Subscribe to future changes
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (_event: AuthChangeEvent, newSession: Session | null) => {
        setSession(newSession)
        setUser(newSession?.user ?? null)
      },
    )

    return () => subscription.unsubscribe()
  }, [client])

  return {
    user,
    session,
    loading,
    signUp: (creds) => client.auth.signUp(creds),
    signIn: (creds) => client.auth.signInWithPassword(creds),
    signInWithOAuth: (opts) => client.auth.signInWithOAuth(opts),
    signInWithOtp: (opts) => client.auth.signInWithOtp(opts),
    signOut: () => client.auth.signOut(),
  }
}
