/**
 * D14 option 2b through the real worker: a call a function makes to the stack's own address carries
 * the end user's address and the project's forwarding secret, so the auth server can believe it.
 * Never to another host, never visible to the function's own code, and never beyond a redirect.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker, type Worker } from "./worker-harness.ts"

const SECRET = "s3cret-forwarding-value"

/** Calls the stack, then another host, then a stack path that redirects to that host. */
const CALLER = `export default async (_req: Request, ctx: { url: string }) => {
  const other = Deno.env.get("OTHER_ORIGIN") ?? ""
  const forged = { headers: { "St-Forwarded-For": "6.6.6.6", "St-Forwarding-Secret": "forged" } }
  await fetch(ctx.url + "/direct", forged)
  await fetch(other + "/other", forged)
  await fetch(ctx.url + "/redirect", forged)
  return new Response(JSON.stringify({ visible: Deno.env.get("SUPATYPE_FORWARDING_SECRET") ?? null }))
}
`

interface Seen {
  path: string
  forwardedFor: string | null
  secret: string | null
}

/** A server that records the two headers of each request, and redirects /redirect to `redirectTo`. */
function recorder(seen: Seen[], redirectTo?: string): { origin: string; stop: () => Promise<void> } {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname
    seen.push({ path, forwardedFor: req.headers.get("st-forwarded-for"), secret: req.headers.get("st-forwarding-secret") })
    if (path === "/redirect" && redirectTo !== undefined) return Response.redirect(`${redirectTo}/landed`, 302)
    return new Response("ok")
  })
  return { origin: `http://127.0.0.1:${server.addr.port}`, stop: () => server.shutdown() }
}

function baseEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  for (const key of ["SUPATYPE_URL", "SUPATYPE_INTERNAL_URL", "SUPATYPE_FORWARDING_SECRET", "SUPATYPE_PUBLIC_URL"]) delete env[key]
  return env
}

interface Run {
  stack: Seen[]
  other: Seen[]
  visible: string | null
}

async function run(inbound: Record<string, string>, secret: string | undefined): Promise<Run> {
  const stack: Seen[] = []
  const other: Seen[] = []
  const otherServer = recorder(other)
  const stackServer = recorder(stack, otherServer.origin)
  let worker: Worker | undefined
  try {
    worker = await startWorker({ caller: CALLER }, {
      ...baseEnv(),
      SUPATYPE_URL: stackServer.origin,
      SUPATYPE_PUBLIC_URL: stackServer.origin,
      OTHER_ORIGIN: otherServer.origin,
      ...(secret !== undefined && { SUPATYPE_FORWARDING_SECRET: secret }),
    })
    const res = await fetch(`${worker.origin}/functions/v1/caller`, { headers: inbound })
    const body: unknown = await res.json()
    const visible = typeof body === "object" && body !== null && "visible" in body ? (body.visible as string | null) : "bad body"
    return { stack, other, visible }
  } finally {
    await worker?.stop()
    await stackServer.stop()
    await otherServer.stop()
  }
}

Deno.test("a call to the stack carries the inbound St-Forwarded-For and the secret, overwriting the function's own", async () => {
  const { stack } = await run({ "St-Forwarded-For": "203.0.113.9", "X-Real-IP": "198.51.100.7" }, SECRET)
  const direct = stack.find((s) => s.path === "/direct")
  expectEqual(direct?.forwardedFor, "203.0.113.9", "address")
  expectEqual(direct?.secret, SECRET, "secret")
})

Deno.test("without St-Forwarded-For the inbound X-Real-IP is the address", async () => {
  const { stack } = await run({ "X-Real-IP": "198.51.100.7" }, SECRET)
  const direct = stack.find((s) => s.path === "/direct")
  expectEqual(direct?.forwardedFor, "198.51.100.7", "address")
  expectEqual(direct?.secret, SECRET, "secret")
})

Deno.test("no other host is sent either header, and the function cannot read the secret", async () => {
  const { other, visible } = await run({ "St-Forwarded-For": "203.0.113.9" }, SECRET)
  const hit = other.find((s) => s.path === "/other")
  expectEqual(hit?.secret, "forged", "the function's own value for another host, which the worker leaves alone")
  expectEqual(hit?.forwardedFor, "6.6.6.6", "the function's own header for another host")
  expectEqual(visible, null, "the secret in the function's environment")
})

Deno.test("a redirect off the stack does not carry the secret along", async () => {
  const { other } = await run({ "St-Forwarded-For": "203.0.113.9" }, SECRET)
  const landed = other.find((s) => s.path === "/landed")
  expectEqual(landed !== undefined, true, "the redirect was still followed")
  expectEqual(landed?.secret, null, "secret after the redirect")
  expectEqual(landed?.forwardedFor, null, "address after the redirect")
})

Deno.test("with no secret configured nothing is added and the function's own header stays", async () => {
  const { stack } = await run({ "St-Forwarded-For": "203.0.113.9" }, undefined)
  const direct = stack.find((s) => s.path === "/direct")
  expectEqual(direct?.secret, "forged", "the function's own value is not replaced")
})
