import type { FunctionContext } from "../_shared/context.ts"

/** Something for each app's function primitive to call. */
export default async function handler(_req: Request, ctx: FunctionContext): Promise<Response> {
  return new Response(JSON.stringify({ ok: true, from: ctx.functionName }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
