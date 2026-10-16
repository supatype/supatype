import { createSignal, onMount, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, AuthRedirectError, SupatypeError, User, Session, AuthChangeEvent } from "@supatype/client"
import { startOAuthRedirect } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

export interface AuthResult {
  user: Accessor<User | null>
  session: Accessor<Session | null>
  loading: Accessor<boolean>
  /** The sign-in the auth server refused and reported in the page's URL, or null. */
  error: Accessor<AuthRedirectError | null>
  signIn: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signUp: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signOut: () => Promise<{ error: SupatypeError | null }>
  /** Send the browser to the provider; a refusal (provider not enabled) is returned instead. */
  signInWithOAuth: (provider: string) => Promise<{ error: SupatypeError | null }>
  resetPassword: (email: string) => Promise<{ error: SupatypeError | null }>
}

export function createAuth<TDatabase extends AnyDatabase = AugmentedDatabase>(): AuthResult {
  const client = useSupatype<TDatabase>()
  const [user, setUser] = createSignal<User | null>(null)
  const [session, setSession] = createSignal<Session | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<AuthRedirectError | null>(null)

  let unsubscribe: (() => void) | null = null

  onMount(async () => {
    try {
      // The initial session, once the client has finished any sign-in the page's URL carries
      const { error: redirectError } = await client.auth.initialize()
      setError(() => redirectError)
      const { data } = await client.auth.getSession()
      if (data.session) {
        setSession(() => data.session)
        setUser(() => data.session!.user)
      }
    } catch {
      // Ignore: user is not authenticated
    }
    setLoading(false)

    const { data: { subscription } } = client.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
      setSession(() => newSession)
      setUser(() => newSession?.user ?? null)
    })
    unsubscribe = () => subscription.unsubscribe()
  })

  onCleanup(() => {
    unsubscribe?.()
  })

  const signIn = async (email: string, password: string) => {
    const { error } = await client.auth.signInWithPassword({ email, password })
    return { error }
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await client.auth.signUp({ email, password })
    return { error }
  }

  const signOut = async () => {
    const { error } = await client.auth.signOut()
    return { error }
  }

  const signInWithOAuth = (provider: string) => startOAuthRedirect(client.auth, provider)

  const resetPassword = async (email: string) => {
    const { error } = await client.auth.resetPasswordForEmail(email)
    return { error }
  }

  return { user, session, loading, error, signIn, signUp, signOut, signInWithOAuth, resetPassword }
}
