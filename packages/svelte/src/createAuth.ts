import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AnyDatabase, SupatypeError, User, Session, AuthChangeEvent } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export interface AuthStore {
  user: Readable<User | null>
  session: Readable<Session | null>
  loading: Readable<boolean>
  signIn: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signUp: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signOut: () => Promise<{ error: SupatypeError | null }>
  signInWithOAuth: (provider: string) => Promise<{ error: SupatypeError | null }>
  resetPassword: (email: string) => Promise<{ error: SupatypeError | null }>
}

export function createAuth<TDatabase extends AnyDatabase = AnyDatabase>(): AuthStore {
  const client = getSupatypeClient<TDatabase>()
  const user = writable<User | null>(null)
  const session = writable<Session | null>(null)
  const loading = writable(true)

  // Get initial session
  client.auth.getSession().then(({ data }) => {
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

  const signUp = async (email: string, password: string) => {
    const { error } = await client.auth.signUp({ email, password })
    return { error }
  }

  const signOut = async () => {
    const { error } = await client.auth.signOut()
    return { error }
  }

  const signInWithOAuth = async (provider: string) => {
    const { error } = await client.auth.signInWithOAuth({ provider })
    return { error }
  }

  const resetPassword = async (email: string) => {
    const { error } = await client.auth.resetPasswordForEmail(email)
    return { error }
  }

  return {
    user: { subscribe: user.subscribe },
    session: { subscribe: session.subscribe },
    loading: { subscribe: loading.subscribe },
    signIn,
    signUp,
    signOut,
    signInWithOAuth,
    resetPassword,
  }
}
