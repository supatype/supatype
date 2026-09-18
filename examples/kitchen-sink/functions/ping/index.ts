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
    JSON.stringify({ ok: true, executionId: ctx.executionId, region: ctx.region }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}
