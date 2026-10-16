import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AugmentedDatabase, AnyDatabase, AuthRedirectError, SupatypeError, User, Session, AuthChangeEvent } from "@supatype/client"
import { startOAuthRedirect } from "@supatype/client/bindings"
import { getSupatypeClient } from "./context.js"

export interface AuthStore {
  user: Readable<User | null>
  session: Readable<Session | null>
  loading: Readable<boolean>
  /** The sign-in the auth server refused and reported in the page's URL, or null. */
  error: Readable<AuthRedirectError | null>
  signIn: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  /** A null `data.session` with a user means the project wants the email confirmed first. */
  signUp: (email: string, password: string) => Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }>
  signOut: () => Promise<{ error: SupatypeError | null }>
  /** Send the browser to the provider; a refusal (provider not enabled) is returned instead. */
  signInWithOAuth: (provider: string) => Promise<{ error: SupatypeError | null }>
  resetPassword: (email: string) => Promise<{ error: SupatypeError | null }>
}

export function createAuth<TDatabase extends AnyDatabase = AugmentedDatabase>(): AuthStore {
  const client = getSupatypeClient<TDatabase>()
  const user = writable<User | null>(null)
  const session = writable<Session | null>(null)
  const loading = writable(true)
  const error = writable<AuthRedirectError | null>(null)

  // The initial session, once the client has finished any sign-in the page's URL carries
  client.auth.initialize().then(({ error: redirectError }) => {
    error.set(redirectError)
    return client.auth.getSession()
  }).then(({ data }) => {
    if (data.session) {
      session.set(data.session)
      user.set(data.session.user)
    }
    loading.set(false)
  }).catch(() => {
    loading.set(false)
  })

  // Subscribe to auth changes
  const { data: { subscription } } = client.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
    session.set(newSession)
    user.set(newSession?.user ?? null)
  })

  onDestroy(() => {
    subscription.unsubscribe()
  })

  const signIn = async (email: string, password: string) => {
    const { error } = await client.auth.signInWithPassword({ email, password })
    return { error }
  }

  const signUp = (email: string, password: string) => client.auth.signUp({ email, password })

  const signOut = async () => {
    const { error } = await client.auth.signOut()
    return { error }
  }

  const signInWithOAuth = (provider: string) => startOAuthRedirect(client.auth, provider)

  const resetPassword = async (email: string) => {
    const { error } = await client.auth.resetPasswordForEmail(email)
    return { error }
  }

  return {
    user: { subscribe: user.subscribe },
    session: { subscribe: session.subscribe },
    loading: { subscribe: loading.subscribe },
    error: { subscribe: error.subscribe },
    signIn,
    signUp,
    signOut,
    signInWithOAuth,
    resetPassword,
  }
}
