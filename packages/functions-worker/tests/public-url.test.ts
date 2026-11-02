/**
 * `ctx.publicUrl` through the real worker: main.ts started as the image starts it, one function
 * served, its context read back over HTTP.
 *
 * Run with `deno task test` from packages/functions-worker. Outside the image's COPY of `*.ts`, so it
 * never ships.
 */

import { expectEqual, startWorker as startHarnessWorker, type Worker } from "./worker-harness.ts"

/** A function that answers with the two addresses it was handed. */
const ECHO = `export default (_req: Request, ctx: { url: string; publicUrl: string }) =>
  new Response(JSON.stringify({ url: ctx.url, publicUrl: ctx.publicUrl }))
`

/** Every variable but the ones under test, so a developer's own shell cannot decide the result. */
function baseEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  delete env["SUPATYPE_PUBLIC_URL"]
  delete env["SUPATYPE_URL"]
  return env
}

function startWorker(env: Record<string, string>): Promise<Worker> {
  return startHarnessWorker({ echo: ECHO }, { ...baseEnv(), ...env })
}

async function contextOf(worker: Worker): Promise<{ url: string; publicUrl: string }> {
  const res = await fetch(`${worker.origin}/functions/v1/echo`)
  const body: unknown = await res.json()
  if (typeof body !== "object" || body === null || !("url" in body) || !("publicUrl" in body)) {
    throw new Error(`unexpected body: ${JSON.stringify(body)}`)
  }
  return { url: String(body.url), publicUrl: String(body.publicUrl) }
}

function publicUrlWarnings(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes('"level":"warn"') && line.includes("SUPATYPE_PUBLIC_URL"))
}

Deno.test("publicUrl is SUPATYPE_PUBLIC_URL, and url is left as it was", async () => {
  const worker = await startWorker({ SUPATYPE_URL: "http://kong:8000", SUPATYPE_PUBLIC_URL: "https://api.acme.dev" })
  try {
    const ctx = await contextOf(worker)
    expectEqual(ctx.publicUrl, "https://api.acme.dev", "publicUrl")
    expectEqual(ctx.url, "http://kong:8000", "url")
    expectEqual(publicUrlWarnings(worker.lines).length, 0, "warnings when the variable is set")
  } finally {
    await worker.stop()
  }
})

Deno.test("publicUrl falls back to url, with one warning at start rather than one per call", async () => {
  const worker = await startWorker({ SUPATYPE_URL: "http://kong:8000" })
  try {
    expectEqual(publicUrlWarnings(worker.lines).length, 1, "warnings before any call")
    const first = await contextOf(worker)
    await contextOf(worker)
    expectEqual(first.publicUrl, "http://kong:8000", "publicUrl fallback")
    expectEqual(publicUrlWarnings(worker.lines).length, 1, "warnings after two calls")
  } finally {
    await worker.stop()
  }
})
