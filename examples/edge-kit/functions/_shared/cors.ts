/** Shared CORS + JSON helpers for edge-kit functions. */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-webhook-signature",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

export function handleOptions(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null
  return new Response(null, { status: 204, headers: corsHeaders })
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  })
}
