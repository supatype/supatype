"use client"

import type { SupatypeClient, SupatypeError } from "@supatype/client"
import { useCallback, useEffect, useState } from "react"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useStudioAuth } from "./useStudioAuth.js"

export type StudioAccessPhase = "loading" | "login" | "forbidden" | "ready"

export interface UseStudioAccessOptions {
  apiBaseUrl: string
  authClient: SupatypeClient
}

export interface UseStudioAccessReturn {
  phase: StudioAccessPhase
  forbiddenMessage: string | null
  signIn(email: string, password: string): Promise<{ error: SupatypeError | null }>
  signOut(): Promise<void>
  retryVerify(): void
}

export function useStudioAccess({ apiBaseUrl, authClient }: UseStudioAccessOptions): UseStudioAccessReturn {
  const { user, session, loading: authLoading, signOut: authSignOut } = useStudioAuth()
  const [phase, setPhase] = useState<StudioAccessPhase>("loading")
  const [forbiddenMessage, setForbiddenMessage] = useState<string | null>(null)
  const [verifyGeneration, setVerifyGeneration] = useState(0)

  const verify = useCallback(async () => {
    if (authLoading) return
    if (!session?.accessToken) {
      setPhase("login")
      setForbiddenMessage(null)
      return
    }

    setPhase("loading")
    setForbiddenMessage(null)

    const base = apiBaseUrl.replace(/\/$/, "")
    try {
      const res = await fetch(`${base}/studio/auth/verify`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          ...studioGatewayHeaders(),
        },
      })
      const json = (await res.json()) as { allowed?: boolean; message?: string; error?: string }
      if (res.ok && json.allowed === true) {
        setPhase("ready")
        return
      }
      const msg = json.message ?? json.error ?? "You don't have permission to access the admin panel"
      if (res.status === 401) {
        setPhase("login")
        return
      }
      setForbiddenMessage(msg)
      setPhase("forbidden")
    } catch {
      setForbiddenMessage("Could not verify Studio access. Check the API is reachable.")
      setPhase("forbidden")
    }
  }, [apiBaseUrl, authLoading, session?.accessToken])

  useEffect(() => {
    void verify()
  }, [verify, verifyGeneration, user?.id])

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.auth.signInWithPassword({ email, password })
      if (result.error === null) {
        setVerifyGeneration((g) => g + 1)
      }
      return result
    },
    [authClient],
  )

  const signOut = useCallback(async () => {
    await authSignOut()
    setPhase("login")
    setForbiddenMessage(null)
  }, [authSignOut])

  const retryVerify = useCallback(() => {
    setVerifyGeneration((g) => g + 1)
  }, [])

  return { phase, forbiddenMessage, signIn, signOut, retryVerify }
}
