import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { supatype } from "./supatype"
import type { User } from "@supatype/client"
import { ensureCustomer, fetchActivity, type Activity, type Customer } from "./api"
import { customerName } from "./customerName"

interface AuthState {
  ready: boolean
  user: User | null
  customer: Customer | null
  activity: Activity[]
  signIn(email: string, password: string): Promise<string | null>
  signUp(name: string, email: string, password: string): Promise<string | null>
  signOut(): Promise<void>
  setCustomer(c: Customer): void
  refreshActivity(): Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>")
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])

  const load = useCallback(async (u: User | null) => {
    if (!u) {
      setCustomer(null)
      setActivity([])
      return
    }
    const c = await ensureCustomer(u.id, customerName(u))
    setCustomer(c)
    setActivity(await fetchActivity(u.id))
  }, [])

  useEffect(() => {
    let active = true
    supatype.auth.getSession().then(async ({ data }) => {
      if (!active) return
      // getSession returns { session }, not { user }, the user lives on the session.
      let session = data.session
      // If a persisted session loaded already expired, refresh before the first
      // data fetch so we don't fire a request with a dead token (one-off 401).
      const exp = session?.expiresAt
      if (session && typeof exp === "number" && exp * 1000 <= Date.now() + 5000) {
        const refreshed = await supatype.auth.refreshSession()
        if (refreshed.data.session) session = refreshed.data.session
      }
      if (!active) return
      const u = session?.user ?? null
      setUser(u)
      await load(u)
      setReady(true)
    })
    return () => {
      active = false
    }
  }, [load])

  const signIn = async (email: string, password: string): Promise<string | null> => {
    const { data, error } = await supatype.auth.signInWithPassword({ email, password })
    if (error) return error.message
    const u = data.user
    setUser(u)
    await load(u)
    return null
  }

  const signUp = async (name: string, email: string, password: string): Promise<string | null> => {
    const { data, error } = await supatype.auth.signUp({ email, password, options: { data: { name } } })
    if (error) return error.message
    // No session means the project wants the email confirmed before the first sign-in.
    if (data.session === null) return "Check your email to confirm your account, then sign in."
    const u = data.user
    setUser(u)
    await load(u)
    return null
  }

  const signOut = async (): Promise<void> => {
    await supatype.auth.signOut()
    setUser(null)
    setCustomer(null)
    setActivity([])
  }

  const refreshActivity = async (): Promise<void> => {
    if (user) setActivity(await fetchActivity(user.id))
  }

  return (
    <AuthContext.Provider
      value={{ ready, user, customer, activity, signIn, signUp, signOut, setCustomer, refreshActivity }}
    >
      {children}
    </AuthContext.Provider>
  )
}
