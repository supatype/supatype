import { useCallback, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { membershipBase } from "../lib/membership-url.js"
import { useAdminClient } from "./useAdminClient.js"

export type LinkState = { status: "idle" | "working" } | { status: "error"; message: string }

/** What an error answer says, from the shapes the project's auth and the control plane use. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; msg?: unknown; error_description?: unknown }
    for (const value of [body.error_description, body.msg, body.message]) {
      if (typeof value === "string" && value !== "") return value
    }
  } catch {
    // Not JSON: the fallback says enough.
  }
  return fallback
}

/** Sign in to the project's own auth through Studio's proxy, which passes the sign-in through. */
async function signInToProject(client: SupatypeClient, email: string, password: string): Promise<string> {
  const res = await fetch(`${client.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    credentials: "include",
    headers: { ...studioAuthHeaders(client), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, "That project login did not work"))
  const body = (await res.json()) as { access_token?: unknown }
  if (typeof body.access_token !== "string") throw new Error("The project's sign-in returned no token")
  return body.access_token
}

/** Hand the sign-in's token to the control plane, which verifies it and stores the link. */
async function storeLink(client: SupatypeClient, accessToken: string): Promise<void> {
  const base = membershipBase(client.url).replace(/\/admin$/, "")
  const res = await fetch(`${base}/studio/identity-link`, {
    method: "POST",
    credentials: "include",
    headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client), "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, "Your account could not be linked"))
}

/**
 * Link the signed-in Cloud account to the member's login for this project (RL2).
 *
 * The member signs in once to the project's own auth; the token that sign-in returns goes straight
 * to the control plane, which checks it with the project's secret and that its email is the
 * account's, and stores the link. The token is held only for that one request, never stored.
 */
export function useLinkAccount(onLinked: () => void): {
  state: LinkState
  link: (email: string, password: string) => Promise<void>
} {
  const client = useAdminClient()
  const [state, setState] = useState<LinkState>({ status: "idle" })

  const link = useCallback(
    async (email: string, password: string) => {
      setState({ status: "working" })
      try {
        await storeLink(client, await signInToProject(client, email, password))
        setState({ status: "idle" })
        onLinked()
      } catch (err) {
        setState({ status: "error", message: err instanceof Error ? err.message : "Your account could not be linked" })
      }
    },
    [client, onLinked],
  )

  return { state, link }
}
