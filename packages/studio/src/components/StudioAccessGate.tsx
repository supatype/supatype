"use client"

import type { Session, SupatypeClient } from "@supatype/client"
import { createClient } from "@supatype/client"
import React, { useMemo } from "react"
import { StudioAuthClientContext } from "../hooks/useAdminClient.js"
import { useStudioAccess } from "../hooks/useStudioAccess.js"
import { useStudioAuth } from "../hooks/useStudioAuth.js"
import { StudioLogin } from "../views/StudioLogin.js"

/** Both clients read and write the one session, under this key. */
const STUDIO_SESSION_KEY = "supatype.auth.session"

/**
 * How to build the proxy client, given who is signed in.
 *
 * **The session is handed over rather than left to be found.** `AuthClient` reads persisted storage
 * once, in its constructor, and this client is built before anybody has signed in: on the gate's
 * first render there is no session to read, and nothing re-reads storage later. So signing in wrote
 * a session that this client could not see, every privileged call went out with no `Authorization`
 * header at all, and the first one to say so was the config fetch, with `HTTP_401`. A page refresh
 * built the client again, this time with storage already populated, which is why it looked like a
 * caching problem and was not.
 *
 * A function, and exported, so the part that was wrong can be tested without a DOM.
 */
export function proxyClientOptions(
  apiBaseUrl: string,
  anonKey: string,
  session: Session | null,
): Parameters<typeof createClient>[0] {
  return {
    url: `${apiBaseUrl.replace(/\/$/, "")}/studio/proxy`,
    anonKey,
    auth: { storageKey: STUDIO_SESSION_KEY },
    ...(session !== null && { initialSession: session }),
  }
}

export interface StudioAccessGateProps {
  apiBaseUrl: string
  anonKey: string
  authClient: SupatypeClient
  children(proxyClient: SupatypeClient): React.ReactElement
}

function StudioAccessGateInner({
  apiBaseUrl,
  anonKey,
  authClient,
  children,
}: StudioAccessGateProps): React.ReactElement {
  const { phase, forbiddenMessage, signIn, signOut, retryVerify } = useStudioAccess({
    apiBaseUrl,
    authClient,
  })

  // The signed-in session, watched rather than read once. `useStudioAuth` already subscribes to
  // this client through the context this component provides, so watching it again here would be a
  // third live subscription to one auth client and a second copy of "who is signed in" that can sit
  // a render behind the first.
  const { session } = useStudioAuth()

  // Built once there is somebody to build it for, and rebuilt when that person changes rather than
  // when their token does. A token refresh does not need a new client: this one persists and
  // refreshes its own session, and rebuilding hourly would discard realtime subscriptions.
  //
  // **Not built before the session arrives.** A client made while signed out still loads whatever is
  // in storage and arms its own refresh timer, and nothing disposes it when the memo replaces it. On
  // a reload while signed in that orphan wakes up an hour later, refreshes against the shared
  // refresh token, writes the result to the shared key and schedules itself again: a client nobody
  // holds, rotating the live client's credential behind its back, for the life of the tab.
  const userId = session?.user.id ?? null
  const proxyClient = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity, seeded with
    // whatever session is current at the moment the identity changes.
    () => (session === null ? null : createClient(proxyClientOptions(apiBaseUrl, anonKey, session))),
    [apiBaseUrl, anonKey, userId],
  )

  if (phase === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-muted-foreground text-sm">Checking access…</div>
      </div>
    )
  }

  if (phase === "login") {
    return (
      <StudioLogin
        apiBaseUrl={apiBaseUrl}
        onSubmit={async (email, password) => {
          const { error } = await signIn(email, password)
          return { error: error?.message ?? null }
        }}
      />
    )
  }

  if (phase === "forbidden") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12 text-center">
        <div className="max-w-md space-y-4">
          <h1 className="text-lg font-semibold text-foreground">Access denied</h1>
          <p className="text-sm text-muted-foreground">
            {forbiddenMessage ?? "You don't have permission to access the admin panel."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => void signOut()}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm"
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={retryVerify}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Ready, but the session has not reached this component yet. One more paint of the same waiting
  // state, rather than a client built with nobody in it.
  if (proxyClient === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-muted-foreground text-sm">Checking access…</div>
      </div>
    )
  }

  return children(proxyClient)
}

export function StudioAccessGate(props: StudioAccessGateProps): React.ReactElement {
  return (
    <StudioAuthClientContext.Provider value={props.authClient}>
      <StudioAccessGateInner {...props} />
    </StudioAuthClientContext.Provider>
  )
}
