import type { AuthListener } from "./auth.js"

/**
 * The part of `AuthClient` this needs.
 *
 * Structural rather than the class itself so a caller, and a test, can supply anything that emits
 * auth changes without constructing a whole client. The callback is `AuthListener`, the same type
 * the real `onAuthStateChange` takes, so the stand-in cannot drift from what it stands in for.
 */
export interface IdentitySource {
  onAuthStateChange(callback: AuthListener): {
    data: { subscription: { unsubscribe(): void } }
  }
}

/**
 * Call `onChange` whenever the signed-in identity changes, and not otherwise.
 *
 * `onAuthStateChange` also fires once at registration and again on every token refresh. A data hook
 * subscribed to it raw would refetch on a timer for as long as the page stayed open, and would
 * refetch once more immediately after the fetch it already makes on mount. This narrows the stream
 * to the only transition that changes what a query is allowed to read: a different user, or none.
 *
 * Returns the unsubscribe function, so a caller can hand it straight to its own teardown hook.
 */
export function onIdentityChange(auth: IdentitySource, onChange: () => void): () => void {
  // `undefined` until the registration emission has established the baseline, so that emission is
  // not itself read as a change.
  let known: string | null | undefined
  const { data } = auth.onAuthStateChange((_event, session) => {
    const userId = session?.user.id ?? null
    if (known === undefined) {
      known = userId
      return
    }
    if (userId === known) return
    known = userId
    onChange()
  })
  return () => {
    data.subscription.unsubscribe()
  }
}
