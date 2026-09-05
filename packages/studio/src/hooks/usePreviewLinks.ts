import { useCallback, useMemo, useState } from "react"
import { membershipBase } from "../lib/membership-url.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"

/** What one link covers. */
export type PreviewScope = "record" | "project"

export interface PreviewLink {
  token: string
  /** ISO timestamp. */
  expiresAt: string
  scope: PreviewScope
}

export interface UsePreviewLinksReturn {
  minting: boolean
  /** Why the last call failed, kept verbatim: the server explains the refusal. */
  error: string | null
  mint: (options: {
    scope: PreviewScope
    model?: string
    recordId?: string
    ttl?: number
  }) => Promise<PreviewLink | null>
  revokeAll: () => Promise<boolean>
}

/**
 * Mint and withdraw the links that let someone without an account read a draft.
 *
 * Not data-plane traffic, so it goes beside `/studio/proxy` rather than through it, the same
 * journey Studio membership takes. The server is the authority on every refusal: whether this
 * project allows project-wide links, whether the caller's role may mint one, and whether the
 * requested lifetime is past the ceiling. A client-side copy of those rules would drift, and the
 * one thing worse than refusing a link is refusing it for the wrong reason.
 *
 * **Revocation is all links at once.** A signed token carries no identity a server could revoke
 * individually without keeping a list of every link ever minted, which is a database of secrets to
 * protect in exchange for a control nobody asked for. Links are short-lived by construction, so
 * re-sharing after a revocation costs a click.
 */
export function usePreviewLinks(): UsePreviewLinksReturn {
  const client = useAdminClient()
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const base = useMemo(() => membershipBase(client.url), [client.url])

  const request = useCallback(
    async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...studioGatewayHeaders(),
          ...studioAuthHeaders(client),
        },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        throw new Error(
          (json["message"] as string | undefined) ??
            (json["error"] as string | undefined) ??
            `Request failed (${res.status})`,
        )
      }
      return json
    },
    [base, client],
  )

  const mint = useCallback<UsePreviewLinksReturn["mint"]>(
    async (options) => {
      setMinting(true)
      setError(null)
      try {
        const body = await request("/preview-links", {
          scope: options.scope,
          ...(options.model !== undefined && { model: options.model }),
          ...(options.recordId !== undefined && { recordId: options.recordId }),
          ...(options.ttl !== undefined && { ttl: options.ttl }),
        })
        return {
          token: String(body["token"] ?? ""),
          expiresAt: String(body["expiresAt"] ?? ""),
          scope: options.scope,
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not mint a preview link")
        return null
      } finally {
        setMinting(false)
      }
    },
    [request],
  )

  const revokeAll = useCallback(async (): Promise<boolean> => {
    setError(null)
    try {
      await request("/preview-links/revoke", {})
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke preview links")
      return false
    }
  }, [request])

  return { minting, error, mint, revokeAll }
}
