import { useEffect, useState } from "react"
import { Platform } from "react-native"
import * as Linking from "expo-linking"
import * as WebBrowser from "expo-web-browser"

/**
 * True in the popup an OAuth sign-in opened on web, once its URL has been handed back.
 *
 * On a phone the auth session returns to the app through the OS. On web it is a popup that lands
 * on this same app at /auth/callback, and `openAuthSessionAsync` in the opening window waits for
 * that page to post its URL back. Nothing posted it, so a web OAuth sign-in never finished. The
 * popup must not complete the sign-in itself as well: the opener exchanges the code, and a second
 * exchange of the same code fails.
 */
export function completesOAuthPopup(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined" || window.opener === null) return false
  return WebBrowser.maybeCompleteAuthSession().type === "success"
}

const isRecoveryLink = (url: string | null): boolean => url !== null && /[?#&]type=recovery(&|$)/.test(url)

/**
 * Whether the app was opened by a password-recovery link, and a way to say the user is done.
 *
 * Following the reset email signs the user in (the URL listener sees to that) and nothing more, so
 * without this the "reset" left the old password in place. While it is true the app asks for a new
 * one before anything else.
 */
export function useRecoveryLink(): { recovering: boolean; done: () => void } {
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    let active = true
    Linking.getInitialURL()
      .then((url) => {
        if (active && isRecoveryLink(url)) setRecovering(true)
      })
      .catch(() => undefined)
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (isRecoveryLink(url)) setRecovering(true)
    })
    return () => {
      active = false
      subscription.remove()
    }
  }, [])

  return { recovering, done: () => setRecovering(false) }
}
