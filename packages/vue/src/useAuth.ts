import { ref, onMounted, onUnmounted, type Ref } from "vue"
import type { AnyDatabase, SupatypeError, User, Session, AuthChangeEvent } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseAuthReturn {
  user: Ref<User | null>
  session: Ref<Session | null>
  loading: Ref<boolean>
  signIn: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signUp: (email: string, password: string) => Promise<{ error: SupatypeError | null }>
  signOut: () => Promise<{ error: SupatypeError | null }>
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
export function useAuth<TDatabase extends AnyDatabase = AnyDatabase>(): UseAuthReturn {
  const client = useSupatype<TDatabase>()
  const user = ref<User | null>(null) as Ref<User | null>
  const session = ref<Session | null>(null) as Ref<Session | null>
  const loading = ref(true)

  let unsubscribe: (() => void) | null = null

  onMounted(async () => {
    // Get initial session
    try {
      const { data } = await client.auth.getSession()
      if (data.session) {
        session.value = data.session
        user.value = data.session.user
      }
    } catch {
      // Ignore — user is not authenticated
    }
    loading.value = false

    // Subscribe to auth changes
    const { data: { subscription } } = client.auth.onAuthStateChange((event: AuthChangeEvent, newSession: Session | null) => {
      session.value = newSession
      user.value = newSession?.user ?? null
    })
    unsubscribe = () => subscription.unsubscribe()
  })

  onUnmounted(() => {
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

  const signInWithOAuth = async (provider: string) => {
    const { error } = await client.auth.signInWithOAuth({ provider })
    return { error }
  }

  const resetPassword = async (email: string) => {
    const { error } = await client.auth.resetPasswordForEmail(email)
    return { error }
  }

  return { user, session, loading, signIn, signUp, signOut, signInWithOAuth, resetPassword }
}
