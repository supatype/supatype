"use client"

import type { SupatypeClient } from "@supatype/client"
import { createClient } from "@supatype/client"
import React, { useMemo } from "react"
import { StudioAuthClientContext } from "../hooks/useAdminClient.js"
import { useStudioAccess } from "../hooks/useStudioAccess.js"
import { StudioLogin } from "../views/StudioLogin.js"

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

  const proxyClient = useMemo(
    () =>
      createClient({
        url: `${apiBaseUrl.replace(/\/$/, "")}/studio/proxy`,
        anonKey,
        auth: { storageKey: "supatype.auth.session" },
      }),
    [apiBaseUrl, anonKey],
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

  return children(proxyClient)
}

export function StudioAccessGate(props: StudioAccessGateProps): React.ReactElement {
  return (
    <StudioAuthClientContext.Provider value={props.authClient}>
      <StudioAccessGateInner {...props} />
    </StudioAuthClientContext.Provider>
  )
}
