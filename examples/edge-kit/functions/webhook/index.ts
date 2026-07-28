import { handleOptions, json } from "../_shared/cors.ts"
import { hmacSha256Hex, timingSafeEqual } from "../_shared/hmac.ts"

/**
 * Verifies `x-webhook-signature` = hex HMAC-SHA256(body, WEBHOOK_SECRET).
 * Set WEBHOOK_SECRET in functions/.env.local (see .env.local.example).
 */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405)
  }

  const secret = Deno.env.get("WEBHOOK_SECRET")
  if (!secret) {
    return json(
      {
        error: "misconfigured",
        message: "Set WEBHOOK_SECRET in functions/.env.local",
      },
      500,
    )
  }

  const raw = await req.text()
  const provided = req.headers.get("x-webhook-signature") ?? ""
  const expected = await hmacSha256Hex(secret, raw)

  if (!timingSafeEqual(provided.toLowerCase(), expected.toLowerCase())) {
    return json({ error: "invalid_signature" }, 401)
  }

  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    // keep raw string
  }

  return json({
    ok: true,
    function: "webhook",
    received: parsed,
  })
}
