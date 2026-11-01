/**
 * A hook the map names but the worker has no code for (a new hook whose deploy failed). It answered
 * 404, which the server's hook dispatch reads as the hook rejecting the write, so the write was
 * refused with a 404 and a "not found" message instead of the 503 that says a hook could not be
 * reached. The worker answers such a route 503, and the server then refuses the write with 503 under
 * the hook's default policy.
 *
 * Only a name the manifest's hook or validator map names is such a hook (review: every unknown
 * hooks/ route answered 503, `hooks/undefined` included). Any other name, and every name when the
 * worker is given no manifest, is a 404 with the routes it has. Native dev runs this same worker.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

/** Starts a worker with one hook, `present`, and the manifest `manifest` when one is given. */
async function workerWithHooks(manifest: Record<string, unknown> | undefined) {
  const hooksRoot = await Deno.makeTempDir({ prefix: "worker-hooks-" })
  await Deno.mkdir(`${hooksRoot}/present`)
  await Deno.writeTextFile(`${hooksRoot}/present/index.ts`, "export default () => new Response(null, { status: 204 })\n")
  const env: Record<string, string> = { ...Deno.env.toObject(), SUPATYPE_HOOKS_ROOT: hooksRoot }
  if (manifest !== undefined) {
    env["SUPATYPE_MANIFEST_PATH"] = `${hooksRoot}/manifest.json`
    await Deno.writeTextFile(env["SUPATYPE_MANIFEST_PATH"], JSON.stringify(manifest))
  }
  const worker = await startWorker({}, env)
  const call = async (path: string): Promise<number> => {
    const res = await fetch(`${worker.origin}/functions/v1/${path}`, { method: "POST", body: "{}" })
    await res.body?.cancel()
    return res.status
  }
  const stop = async () => {
    await worker.stop()
    await Deno.remove(hooksRoot, { recursive: true })
  }
  return { call, stop }
}

const MANIFEST = {
  hooks: { note: { beforeChange: { function: "never-deployed" } } },
  validators: { memo: { title: { function: "never-deployed-validator" } } },
}

Deno.test("a hook the map names with no code answers 503; one it has code for runs", async () => {
  const worker = await workerWithHooks(MANIFEST)
  try {
    expectEqual(await worker.call("hooks/never-deployed"), 503, "a mapped hook with no code")
    expectEqual(await worker.call("hooks/never-deployed-validator"), 503, "a mapped validator with no code")
    expectEqual(await worker.call("hooks/present"), 204, "a hook with code")
  } finally {
    await worker.stop()
  }
})

Deno.test("a hook name no map names, a hook route with no name, and a function with no code answer 404", async () => {
  const worker = await workerWithHooks(MANIFEST)
  try {
    expectEqual(await worker.call("hooks/never-mapped"), 404, "an unmapped hook name")
    expectEqual(await worker.call("hooks/undefined"), 404, "hooks/undefined")
    expectEqual(await worker.call("hooks/"), 404, "a hooks route with no name")
    expectEqual(await worker.call("no-such-function"), 404, "a function with no code")
  } finally {
    await worker.stop()
  }
})

Deno.test("with no manifest given, an unknown hook route is a 404", async () => {
  const worker = await workerWithHooks(undefined)
  try {
    expectEqual(await worker.call("hooks/never-deployed"), 404, "no manifest to say it is mapped")
  } finally {
    await worker.stop()
  }
})
