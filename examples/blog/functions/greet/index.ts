// greet, Supatype Edge Function
// Docs: https://supatype.com/docs/edge-functions

import type { FunctionContext } from "../_shared/context.ts"

export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  const { method } = req
  // From the context, not the environment. Per-invocation values are passed in, which is what lets
  // the worker run your functions concurrently instead of one at a time.
  //
  // publicUrl is the address a browser or an app uses, for links you give to people. Its sibling,
  // url, is for calling the API from inside this function, and under Docker no browser can open it.
  const { publicUrl } = ctx

  // Example: read request body for POST requests
  if (method === "POST") {
    const body: unknown = await req.json()
    return new Response(JSON.stringify({ message: "Hello from greet!", received: body, publicUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ message: "Hello from greet!", publicUrl }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
