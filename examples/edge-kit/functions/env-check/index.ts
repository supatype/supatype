import type { FunctionContext } from "../_shared/context.ts"
import { handleOptions, json } from "../_shared/cors.ts"

/**
 * Confirms what the functions worker or `supatype functions serve` hands a call: the Supatype keys
 * on ctx, and WEBHOOK_SECRET from functions/.env.local in ctx.env, which is where env values arrive.
 */
export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  return json({
    ok: true,
    function: "env-check",
    hasSupatypeUrl: Boolean(ctx.url),
    hasAnonKey: Boolean(ctx.anonKey),
    hasServiceRoleKey: ctx.serviceRoleKey !== undefined,
    hasWebhookSecret: Boolean(ctx.env["WEBHOOK_SECRET"]),
    region: ctx.region,
  })
}
