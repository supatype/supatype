/**
 * Which auth transitions a data hook should re-run on.
 *
 * The bindings' queries fetch once when their component mounts, which is before anybody has signed
 * in, so on a table guarded by a logged-in policy that fetch reads nothing and the view stayed
 * empty until something else called refetch. They now re-run on identity change, and this is the
 * narrowing that makes that affordable: `onAuthStateChange` also fires at registration and on every
 * token refresh, and re-running on those would double every mount's fetch and then refetch on a
 * timer for as long as the page stayed open.
 */

import { describe, it, expect, vi } from "vitest"
import { onIdentityChange, type IdentitySource } from "../src/identity.js"
import type { AuthChangeEvent, Session } from "../src/types.js"

/** An auth client stand-in whose emissions the test drives by hand. */
function fakeAuth(): {
  source: IdentitySource
  emit: (event: AuthChangeEvent, session: Session | null) => void
  unsubscribed: () => number
} {
  let listener: ((event: AuthChangeEvent, session: Session | null) => void) | null = null
  let unsubscribes = 0
  return {
    source: {
      onAuthStateChange(callback) {
        listener = callback
        return { data: { subscription: { unsubscribe: () => { unsubscribes += 1 } } } }
      },
    },
    emit: (event, session) => listener?.(event, session),
    unsubscribed: () => unsubscribes,
  }
}

function sessionFor(userId: string, accessToken = "token"): Session {
  return {
    accessToken,
    tokenType: "bearer",
    expiresIn: 3600,
    refreshToken: "refresh",
    user: {
      id: userId,
      email: `${userId}@example.com`,
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
  } as Session
}

describe("onIdentityChange", () => {
  it("does not fire on the emission onAuthStateChange makes at registration", () => {
    const auth = fakeAuth()
    const onChange = vi.fn()
    onIdentityChange(auth.source, onChange)

    // AuthClient calls back synchronously when a listener registers. Treating that as a change
    // would refetch immediately after the fetch the caller has already made on mount.
    auth.emit("SIGNED_OUT", null)

    expect(onChange).not.toHaveBeenCalled()
  })

  it("fires when a signed-out page signs in", () => {
    const auth = fakeAuth()
    const onChange = vi.fn()
    onIdentityChange(auth.source, onChange)
    auth.emit("SIGNED_OUT", null)

    auth.emit("SIGNED_IN", sessionFor("user-1"))

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("does not fire on a token refresh for the same user", () => {
    const auth = fakeAuth()
    const onChange = vi.fn()
    onIdentityChange(auth.source, onChange)
    auth.emit("SIGNED_IN", sessionFor("user-1", "first"))

    auth.emit("TOKEN_REFRESHED", sessionFor("user-1", "second"))
    auth.emit("TOKEN_REFRESHED", sessionFor("user-1", "third"))

    expect(onChange).not.toHaveBeenCalled()
  })

  it("fires on sign out", () => {
    const auth = fakeAuth()
    const onChange = vi.fn()
    onIdentityChange(auth.source, onChange)
    auth.emit("SIGNED_IN", sessionFor("user-1"))

    auth.emit("SIGNED_OUT", null)

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("fires when one user replaces another", () => {
    const auth = fakeAuth()
    const onChange = vi.fn()
    onIdentityChange(auth.source, onChange)
    auth.emit("SIGNED_IN", sessionFor("user-1"))

    auth.emit("SIGNED_IN", sessionFor("user-2"))

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes the underlying listener when torn down", () => {
    const auth = fakeAuth()
    const stop = onIdentityChange(auth.source, vi.fn())

    stop()

    expect(auth.unsubscribed()).toBe(1)
  })
})
