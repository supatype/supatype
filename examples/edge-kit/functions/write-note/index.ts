import { apiBaseUrl } from "../_shared/api.ts"
import { handleOptions, json } from "../_shared/cors.ts"

/**
 * Inserts a Note row via PostgREST using the service-role key from Deno.env.
 * Exercises env injection + outbound fetch from the worker.
 */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405)
  }

  const serviceKey = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY")
  if (!serviceKey) {
    return json(
      {
        error: "misconfigured",
        message: "SUPATYPE_SERVICE_ROLE_KEY must be set in the function runtime",
      },
      500,
    )
  }

  let baseUrl: string
  try {
    baseUrl = apiBaseUrl()
  } catch (err) {
    return json(
      {
        error: "misconfigured",
        message: err instanceof Error ? err.message : "SUPATYPE_URL missing",
      },
      500,
    )
  }

  let text = "hello from write-note"
  try {
    const parsed = (await req.json()) as { text?: unknown }
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
      text = parsed.text.trim()
    }
  } catch {
    // keep default body text
  }

  const res = await fetch(`${baseUrl}/rest/v1/note`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ body: text }),
  })

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    return json(
      {
        error: "rest_failed",
        status: res.status,
        baseUrl,
        payload,
      },
      502,
    )
  }

  return json({
    ok: true,
    function: "write-note",
    baseUrl,
    note: Array.isArray(payload) ? payload[0] ?? null : payload,
  })
}
