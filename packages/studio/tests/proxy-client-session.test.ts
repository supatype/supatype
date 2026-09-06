import { describe, expect, it } from "vitest"
import { proxyClientOptions } from "../src/components/StudioAccessGate.js"
import type { Session } from "@supatype/client"

// Signing in used to leave Studio unauthenticated until the page was refreshed.
//
// The gate builds a second client for the privileged proxy, and `AuthClient` reads persisted
// storage exactly once, in its constructor. That client was memoised on the API base URL and the
// anon key, so it was constructed on the gate's first render, before anybody had signed in, with no
// session to find and nothing to make it look again. Signing in wrote a session it could not see:
// every privileged call went out with no `Authorization` header, and the first to complain was the
// config fetch, with `HTTP_401`. Refreshing rebuilt the client against populated storage, which is
// exactly why it looked like a caching problem and was not.
//
// So the session is handed over rather than left to be found, and this is the assertion that says
// so. The gate's React wiring around it needs a DOM, which this suite deliberately does not have;
// what is testable here is the part that was actually wrong.

function session(userId: string, token = "jwt-token"): Session {
  return {
    accessToken: token,
    refreshToken: "refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: "someone@example.com" },
  } as unknown as Session
}

describe("the proxy client's options", () => {
  it("carries the session, so the client does not have to find one", () => {
    const opts = proxyClientOptions("http://localhost:18473", "anon", session("u1"))
    expect(opts.initialSession).not.toBeUndefined()
    expect(opts.initialSession?.accessToken).toBe("jwt-token")
  })

  it("carries none before anybody has signed in", () => {
    // Not an empty session object: `AuthClient` treats a provided `initialSession` as authoritative
    // and skips reading storage, so handing it a hollow one would lock the client signed out on a
    // page that loads with a perfectly good session already stored.
    const opts = proxyClientOptions("http://localhost:18473", "anon", null)
    expect(opts.initialSession).toBeUndefined()
  })

  it("points at the proxy, not at the API root", () => {
    // The whole reason for a second client. The proxy resolves Studio membership, applies the
    // role's permissions and records elevated access; the API root does none of that.
    expect(proxyClientOptions("http://localhost:18473", "anon", null).url).toBe(
      "http://localhost:18473/studio/proxy",
    )
  })

  it("does not double the slash when the base URL has a trailing one", () => {
    expect(proxyClientOptions("http://localhost:18473/", "anon", null).url).toBe(
      "http://localhost:18473/studio/proxy",
    )
  })

  it("shares the one storage key with the sign-in client", () => {
    // Two clients, one session. A different key here would give the proxy its own private session
    // that signing in never writes to.
    expect(proxyClientOptions("http://x", "anon", null).auth?.storageKey).toBe(
      "supatype.auth.session",
    )
  })
})
