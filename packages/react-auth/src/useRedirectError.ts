import { useEffect, useRef } from "react"
import type { AuthRedirectError } from "@supatype/client"
import { useAuth } from "@supatype/react"

/**
 * The sign-in the auth server refused and sent back in the page's URL, when `provider` started it,
 * else null. `onError` hears it once, through a ref so an inline handler does not hear it again on
 * every render.
 */
export function useRedirectError(
  provider: string,
  onError: ((error: AuthRedirectError) => void) | undefined,
): AuthRedirectError | null {
  const { error } = useAuth()
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const mine = error !== null && error.provider === provider ? error : null
  useEffect(() => {
    if (mine !== null) onErrorRef.current?.(mine)
  }, [mine])
  return mine
}
