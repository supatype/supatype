import { handleOptions, json } from "../_shared/cors.ts"

/** Confirms Deno.env injection from the functions worker / `supatype functions serve`. */
export default async function handler(req: Request): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  return json({
    ok: true,
    function: "env-check",
    hasSupatypeUrl: Boolean(Deno.env.get("SUPATYPE_URL")),
    hasAnonKey: Boolean(Deno.env.get("SUPATYPE_ANON_KEY")),
    hasServiceRoleKey: Boolean(Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY")),
    hasWebhookSecret: Boolean(Deno.env.get("WEBHOOK_SECRET")),
    region: Deno.env.get("SUPATYPE_REGION") ?? null,
  })
}
