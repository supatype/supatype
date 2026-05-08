"use client"

import type { Session, AuthChangeEvent, SupatypeError, User } from "@supatype/client"
import { useContext, useEffect, useState } from "react"
import { AdminClientContext } from "./useAdminClient.js"

export interface UseStudioAuthReturn {
  user: User | null
  session: Session | null
  loading: boolean
  signOut(): Promise<{ error: SupatypeError | null }>
}

/**
 * Same shape as `useAuth` from `@supatype/react`, but reads `AdminClientContext`
 * so Studio does not need a second provider for the same client instance.
 */
export function useStudioAuth(): UseStudioAuthReturn {
  const client = useContext(AdminClientContext)
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (client === null) {
      setSession(null)
      setUser(null)
      setLoading(false)
      return
    }

    void client.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

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
    signOut: () => (client !== null ? client.auth.signOut() : Promise.resolve({ error: null })),
  }
}
