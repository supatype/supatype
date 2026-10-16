import type { SupatypeClient } from "@supatype/client"
import type { StudioConfigErrorKind } from "../components/StudioConfigError.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"
import { studioGatewayHeaders } from "./studio-gateway-headers.js"

/** One answer from `/studio-config`: the raw body, so a caller can tell an unchanged config cheaply. */
export type StudioConfigFetch =
  | { ok: true; body: string }
  | { ok: false; kind: StudioConfigErrorKind; detail?: string }

/** How a refused answer reads to someone looking at Studio. */
function refusal(status: number): StudioConfigFetch {
  if (status === 404) return { ok: false, kind: "not_pushed" }
  // A refused session, not a broken deployment. This used to fall through to "unknown", whose
  // heading is "Could not load Studio config", which reads as a fault in the stack and sends people
  // to look at their schema, their engine and their containers. The config API is answering
  // perfectly well; it is this browser's token that is no longer valid, and a server restart is
  // enough to get here.
  if (status === 401 || status === 403) return { ok: false, kind: "signed_out", detail: `HTTP_${status}` }
  return { ok: false, kind: "unknown", detail: `HTTP_${status}` }
}

/**
 * Ask the project for the admin config of its latest push.
 *
 * The engine answers from the migration history in the database, so this is always the config of
 * the schema the database has now, never a copy from when Studio loaded. Never rejects: a network
 * failure is an answer like any other.
 */
export async function fetchStudioConfig(apiBaseUrl: string, client: SupatypeClient): Promise<StudioConfigFetch> {
  const base = apiBaseUrl.replace(/\/$/, "")
  try {
    const res = await fetch(`${base}/studio-config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...studioGatewayHeaders(),
        ...studioAuthHeaders(client),
      },
      body: "{}",
      credentials: "omit",
    })
    const text = await res.text()
    return res.ok ? { ok: true, body: text } : refusal(res.status)
  } catch (e: unknown) {
    return { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) }
  }
}
