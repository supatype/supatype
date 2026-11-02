/**
 * The starter function both scaffolds write: `supatype init`'s hello function and
 * `supatype functions new <name>`.
 *
 * One definition because there were two, near-identical string literals in `init.ts` and
 * `functions.ts`, and a change to what a new function teaches would otherwise reach one scaffold
 * and not the other.
 */
export function functionTemplateSource(name: string): string {
  return `// ${name}: Supatype Edge Function

import type { FunctionContext } from "../_shared/context.ts"

export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  // From the context, not the environment. Per-invocation values are passed in, which is what lets
  // the worker run your functions concurrently instead of one at a time.
  //
  // publicUrl is the address a browser or an app uses, for links you give to people. Its sibling,
  // url, is for calling the API from inside this function, and under Docker no browser can open it.
  const { publicUrl } = ctx

  // A request may carry a JSON body. One with no body is answered as a GET is.
  const body = await readBody(req)
  if (body.kind === "invalid") return json({ error: "The request body is not valid JSON" }, 400)
  if (body.kind === "none") return json({ message: "Hello from ${name}!", publicUrl })
  return json({ message: "Hello from ${name}!", received: body.value, publicUrl })
}

type Body = { kind: "none" } | { kind: "json"; value: unknown } | { kind: "invalid" }

/** The request's body: none when it is empty, else its JSON, or invalid when it is not JSON. */
async function readBody(req: Request): Promise<Body> {
  const text = await req.text()
  if (text.trim() === "") return { kind: "none" }
  try {
    return { kind: "json", value: JSON.parse(text) }
  } catch {
    return { kind: "invalid" }
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}
`
}
