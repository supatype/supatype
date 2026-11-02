/**
 * The blog example's `greet` function, served by the real worker. It called req.json() on every
 * POST, so a POST with no body answered 500 "Unexpected end of JSON input". It reads the body as
 * the CLI's starter function does: none answers as a GET, JSON is echoed, anything else is a 400.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

/** `key` of a JSON object, or undefined. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Object.entries(value).find(([k]) => k === key)?.[1] : undefined
}

const GREET = await Deno.readTextFile(new URL("../../../examples/blog/functions/greet/index.ts", import.meta.url))

Deno.test("the blog's greet answers a POST with no body, JSON, or anything else", async () => {
  const worker = await startWorker({ greet: GREET }, Deno.env.toObject())
  try {
    const post = (body?: string) => fetch(`${worker.origin}/functions/v1/greet`, { method: "POST", ...(body !== undefined && { body }) })
    const empty = await post()
    expectEqual(empty.status, 200, "an empty POST")
    expectEqual(field(await empty.json(), "message"), "Hello from greet!", "its message")
    const sent = await post(JSON.stringify({ name: "Ada" }))
    expectEqual(JSON.stringify(field(await sent.json(), "received")), JSON.stringify({ name: "Ada" }), "the JSON it echoes")
    const invalid = await post("not json")
    expectEqual(invalid.status, 400, "a body that is not JSON")
    await invalid.body?.cancel()
  } finally {
    await worker.stop()
  }
})
