import { useEffect, useState } from "react"
import { useSupatype } from "@supatype/react"

export interface PasswordRecovery {
  /** True from the moment a password reset link signs the user in until `finish` or a sign-out. */
  active: boolean
  /** Call once the new password is set, so the app shows itself again. */
  finish: () => void
}

/**
 * Whether the user arrived through a password reset link and still has to choose a new password.
 *
 * The link signs the user in and the client emits `PASSWORD_RECOVERY` after `SIGNED_IN`. Without
 * this an app that renders whenever there is a user drops them inside it, signed in with the
 * password they forgot. Show `UpdatePasswordForm` while `active`.
 *
 * Must be rendered inside a `<SupatypeProvider>`, mounted from the first render (beside `useAuth`),
 * because the event is emitted once while the client finishes the link on start.
 */
export function usePasswordRecovery(): PasswordRecovery {
  const client = useSupatype()
  const [active, setActive] = useState(false)
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setActive(true)
      if (event === "SIGNED_OUT") setActive(false)
    })
    return () => data.subscription.unsubscribe()
  }, [client])
  return { active, finish: () => setActive(false) }
}
