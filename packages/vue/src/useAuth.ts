import { ref, onMounted, onUnmounted, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, AuthRedirectError, SupatypeError, User, Session, AuthChangeEvent } from "@supatype/client"
import { reportThrown, startOAuthRedirect } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

export interface UseAuthReturn {
  user: Ref<User | null>
  session: Ref<Session | null>
  loading: Ref<boolean>
  /** The sign-in the auth server refused and reported in the page's URL, or null. */
  error: Ref<AuthRedirectError | null>
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

/**
 * Authentication composable for Supatype.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useAuth } from '@supatype/vue'
 *
 * const { user, loading, signIn, signOut } = useAuth()
 * </script>
 *
 * <template>
 *   <div v-if="loading">Loading...</div>
 *   <div v-else-if="user">
 *     <p>Signed in as {{ user.email }}</p>
 *     <button @click="signOut">Sign out</button>
 *   </div>
 *   <form v-else @submit.prevent="signIn(email, password)">...</form>
 * </template>
 * ```
 */
export function useAuth<TDatabase extends AnyDatabase = AugmentedDatabase>(): UseAuthReturn {
  const client = useSupatype<TDatabase>()
  const user = ref<User | null>(null) as Ref<User | null>
  const session = ref<Session | null>(null) as Ref<Session | null>
  const loading = ref(true)
  const error = ref<AuthRedirectError | null>(null) as Ref<AuthRedirectError | null>

  let unsubscribe: (() => void) | null = null

  onMounted(async () => {
    // Subscribe before awaiting anything: an unmount while the client is still starting runs the
    // cleanup below, which can only remove a listener that already exists.
    const { data: { subscription } } = client.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
      session.value = newSession
      user.value = newSession?.user ?? null
    })
    unsubscribe = () => subscription.unsubscribe()

    // Initial session, once the client has finished any sign-in the page's URL carries
    try {
      error.value = (await client.auth.initialize()).error
      const { data } = await client.auth.getSession()
      if (data.session) {
        session.value = data.session
        user.value = data.session.user
      }
    } catch (e) {
      // Starting threw (a client with no API address, say): there is no session to wait for.
      error.value = reportThrown("useAuth", e)
    }
    loading.value = false
  })

  onUnmounted(() => {
    unsubscribe?.()
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

  return { user, session, loading, error, signIn, signUp, signOut, signInWithOAuth, resetPassword }
}
