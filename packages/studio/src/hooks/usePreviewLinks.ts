import { useCallback, useMemo, useState } from "react"
import { membershipBase } from "../lib/membership-url.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"

/** What one link covers. */
export type PreviewScope = "record" | "project"

/** A freshly minted link. The code is in it exactly once. */
export interface MintedPreviewLink {
  /** The credential. Shown once and never stored: this is the only time Studio holds it. */
  code: string
  /** The link's public identity, which is what a later revoke names. */
  id: string
  /** ISO timestamp. */
  expiresAt: string
  scope: PreviewScope
}

/** An outstanding link, as listed. It carries no credential. */
export interface PreviewLinkSummary {
  id: string
  scope: PreviewScope
  createdAt: string
  expiresAt: string
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
  }) => Promise<MintedPreviewLink | null>
  list: (model: string, recordId: string) => Promise<PreviewLinkSummary[]>
  revoke: (id: string) => Promise<boolean>
  revokeAll: () => Promise<boolean>
}

/**
 * Mint, list and withdraw the links that let someone without an account read a draft.
 *
 * Not data-plane traffic, so it goes beside `/studio/proxy` rather than through it, the same
 * journey Studio membership takes. The server is the authority on every refusal: whether this
 * project allows project-wide links, whether the caller's role may mint one, and whether the
 * requested lifetime is past the ceiling. A client-side copy of those rules would drift, and the
 * one thing worse than refusing a link is refusing it for the wrong reason.
 *
 * **A link can be revoked on its own.** It used to be all or nothing: the link was a signed token,
 * which cannot be recalled, so withdrawing one meant bumping a counter that stranded every other
 * link in the project. Sending a link to the wrong person therefore broke everyone else's. A link
 * is now an id and a secret with only the id kept, so there is something to name and take back, and
 * `revokeAll` survives as the panic button rather than as the only button.
 */
export function usePreviewLinks(): UsePreviewLinksReturn {
  const client = useAdminClient()
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const base = useMemo(() => membershipBase(client.url), [client.url])

  const request = useCallback(
    async (
      path: string,
      init: { method: "GET" | "POST"; body?: Record<string, unknown> },
    ): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, {
        method: init.method,
        credentials: "include",
        headers: {
          // Only where there is a body to describe. On a GET it says nothing, and it is not a
          // CORS-safelisted value, so it is pure weight on a cross-origin deployment.
          ...(init.body !== undefined && { "Content-Type": "application/json" }),
          ...studioGatewayHeaders(),
          ...studioAuthHeaders(client),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
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
          method: "POST",
          body: {
            scope: options.scope,
            ...(options.model !== undefined && { model: options.model }),
            ...(options.recordId !== undefined && { recordId: options.recordId }),
            ...(options.ttl !== undefined && { ttl: options.ttl }),
          },
        })
        return {
          code: String(body["code"] ?? ""),
          id: String(body["id"] ?? ""),
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

  const list = useCallback<UsePreviewLinksReturn["list"]>(
    async (model, recordId) => {
      try {
        const query = `?model=${encodeURIComponent(model)}&recordId=${encodeURIComponent(recordId)}`
        const body = await request(`/preview-links${query}`, { method: "GET" })
        const rows = Array.isArray(body["links"]) ? (body["links"] as Record<string, unknown>[]) : []
        return rows.map((row) => ({
          id: String(row["id"] ?? ""),
          scope: (String(row["scope"] ?? "record") === "project"
            ? "project"
            : "record") as PreviewScope,
          createdAt: String(row["createdAt"] ?? ""),
          expiresAt: String(row["expiresAt"] ?? ""),
        }))
      } catch {
        // Not surfaced as the panel's error: failing to list is not failing to share, and putting
        // it in the same place would make a read problem look like the mint being refused.
        return []
      }
    },
    [request],
  )

  const revoke = useCallback<UsePreviewLinksReturn["revoke"]>(
    async (id) => {
      setError(null)
      try {
        await request(`/preview-links/${encodeURIComponent(id)}/revoke`, { method: "POST" })
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not revoke that preview link")
        return false
      }
    },
    [request],
  )

  const revokeAll = useCallback(async (): Promise<boolean> => {
    setError(null)
    try {
      await request("/preview-links/revoke", { method: "POST", body: {} })
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke preview links")
      return false
    }
  }, [request])

  return { minting, error, mint, list, revoke, revokeAll }
}
