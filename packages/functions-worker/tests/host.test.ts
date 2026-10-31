/**
 * Where the worker listens. Every address in its container, as the image runs it; on a developer's
 * machine (native `supatype dev`, `supatype functions serve`) the caller names 127.0.0.1 through
 * SUPATYPE_FUNCTIONS_HOST, so nothing else on the network reaches the project's functions.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const FUNCTIONS = { hello: 'export default () => new Response("hello ok")\n' }

/** The host the worker said it listens on. */
function listeningHost(lines: readonly string[]): string {
  const line = lines.find((l) => l.includes("listening on")) ?? ""
  return /listening on http:\/\/([^:]+):/.exec(line)?.[1] ?? ""
}

Deno.test("listens on the host SUPATYPE_FUNCTIONS_HOST names", async () => {
  const worker = await startWorker(FUNCTIONS, { ...Deno.env.toObject(), SUPATYPE_FUNCTIONS_HOST: "127.0.0.1" })
  try {
    expectEqual(listeningHost(worker.lines), "127.0.0.1", "host")
  } finally {
    await worker.stop()
  }
})

Deno.test("listens on every address when no host is named, as in its container", async () => {
  const env = Deno.env.toObject()
  delete env["SUPATYPE_FUNCTIONS_HOST"]
  const worker = await startWorker(FUNCTIONS, env)
  try {
    expectEqual(listeningHost(worker.lines), "0.0.0.0", "host")
  } finally {
    await worker.stop()
  }
})

// Round 6 N27: a function of several files, as the control plane now writes it, answers.
Deno.test("serves a function that imports a module of its own", async () => {
  const worker = await startWorker(
    {
      multi: 'import { greet } from "./lib/greet.ts"\nexport default () => new Response(greet())\n',
      "multi/lib/greet.ts": 'export const greet = (): string => "hi from lib"\n',
    },
    Deno.env.toObject(),
  )
  try {
    const res = await fetch(`${worker.origin}/functions/v1/multi`)
    expectEqual(await res.text(), "hi from lib", "the answer")
  } finally {
    await worker.stop()
  }
})
