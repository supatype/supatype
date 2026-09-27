import type { FunctionContext } from "../_shared/context.ts"

/**
 * The smallest thing that proves a function ran.
 *
 * Every other function here does something that could fail for its own reasons — a write refused, a
 * token rejected. This one cannot, so when it fails the worker itself is what is wrong, which is
 * worth being able to tell apart.
 */
export default async function handler(_req: Request, ctx: FunctionContext): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      executionId: ctx.executionId,
      region: ctx.region,
      // Reported, never returned. `ctx.dbUrl` is a credential, and the point here is only whether
      // the deployment handed the worker one: the compose generator never passed it through, so
      // this was permanently undefined on self-host with nothing to say why. Opt in by setting
      // SUPATYPE_FUNCTIONS_DB_URL in .env.
      hasDbUrl: Boolean(ctx.dbUrl),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}
