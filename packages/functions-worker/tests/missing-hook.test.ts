/**
 * A hook the map names but the worker has no code for (a new hook whose deploy failed). It answered
 * 404, which the server's hook dispatch reads as the hook rejecting the write, so the write was
 * refused with a 404 and a "not found" message instead of the 503 that says a hook could not be
 * reached. The worker answers such a route 503, and the server then refuses the write with 503 under
 * the hook's default policy. A plain function route it does not have is still a 404. Native dev runs
 * this same worker.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

Deno.test("a hook route with no code answers 503; a function route with none answers 404", async () => {
  const hooksRoot = await Deno.makeTempDir({ prefix: "worker-hooks-" })
  await Deno.mkdir(`${hooksRoot}/present`)
  await Deno.writeTextFile(`${hooksRoot}/present/index.ts`, "export default () => new Response(null, { status: 204 })\n")
  const worker = await startWorker({}, { ...Deno.env.toObject(), SUPATYPE_HOOKS_ROOT: hooksRoot })
  try {
    const call = async (path: string): Promise<number> => {
      const res = await fetch(`${worker.origin}/functions/v1/${path}`, { method: "POST", body: "{}" })
      await res.body?.cancel()
      return res.status
    }
    expectEqual(await call("hooks/never-deployed"), 503, "a hook with no code")
    expectEqual(await call("hooks/present"), 204, "a hook with code")
    expectEqual(await call("no-such-function"), 404, "a function with no code")
  } finally {
    await worker.stop()
    await Deno.remove(hooksRoot, { recursive: true })
  }
})
