/**
 * A hook route the worker has no code for (a new hook whose deploy failed). A 404 is read by the
 * server's hook dispatch as the hook rejecting the write, with a "not found" message; a 503 says the
 * hook could not be reached, and the server refuses the write with 503 under the default policy.
 *
 * With a manifest (SUPATYPE_MANIFEST_PATH, self-host and native dev), only a name its hook or
 * validator map names is a 503, and any other is a 404. With none (Cloud's worker), or one that
 * cannot be read or parsed (caught mid-rewrite), it fails closed: every name that passes the hook-name
 * rule is a 503. A route with no hook segment (`hooks/`), or a name the rule refuses, is a 404.
 * Native dev runs this same worker.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

/** Starts a worker with one hook, `present`; `manifest` is written to the manifest path when given. */
async function workerWithHooks(manifest: string | undefined) {
  const hooksRoot = await Deno.makeTempDir({ prefix: "worker-hooks-" })
  await Deno.mkdir(`${hooksRoot}/present`)
  await Deno.writeTextFile(`${hooksRoot}/present/index.ts`, "export default () => new Response(null, { status: 204 })\n")
  const manifestPath = `${hooksRoot}/manifest.json`
  const env: Record<string, string> = { ...Deno.env.toObject(), SUPATYPE_HOOKS_ROOT: hooksRoot }
  if (manifest !== undefined) {
    env["SUPATYPE_MANIFEST_PATH"] = manifestPath
    await Deno.writeTextFile(manifestPath, manifest)
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
  return { call, stop, manifestPath }
}

const MANIFEST = JSON.stringify({
  hooks: { note: { beforeChange: { function: "never-deployed" } } },
  validators: { memo: { title: { function: "never-deployed-validator" } } },
})

Deno.test("with a manifest: a mapped hook with no code is 503, one with code runs", async () => {
  const worker = await workerWithHooks(MANIFEST)
  try {
    expectEqual(await worker.call("hooks/never-deployed"), 503, "a mapped hook with no code")
    expectEqual(await worker.call("hooks/never-deployed-validator"), 503, "a mapped validator with no code")
    expectEqual(await worker.call("hooks/present"), 204, "a hook with code")
  } finally {
    await worker.stop()
  }
})

Deno.test("with a manifest: an unmapped name, no name and a missing function are 404", async () => {
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

// Review: Cloud's worker is given no manifest, and lost the 503 entirely.
Deno.test("with no manifest: a valid hook name is 503, a missing or invalid one 404", async () => {
  const worker = await workerWithHooks(undefined)
  try {
    expectEqual(await worker.call("hooks/never-deployed"), 503, "a valid hook name")
    expectEqual(await worker.call("hooks/onUserCreate"), 503, "a mixed-case hook name")
    // A route with no hook segment names no hook; "undefined" is a name like any other.
    expectEqual(await worker.call("hooks/"), 404, "a hooks route with no name")
    expectEqual(await worker.call("hooks/undefined"), 503, "a hook literally named undefined")
    expectEqual(await worker.call("hooks/bad.name"), 404, "a name the hook rule refuses")
  } finally {
    await worker.stop()
  }
})

// Review: a manifest read while it was being rewritten parsed as nothing, and every hook was a 404.
Deno.test("a manifest that cannot be parsed fails closed: a valid hook name is 503", async () => {
  const worker = await workerWithHooks('{"hooks": {"note": ')
  try {
    expectEqual(await worker.call("hooks/never-deployed"), 503, "a valid hook name")
    expectEqual(await worker.call("hooks/"), 404, "a hooks route with no name")
  } finally {
    await worker.stop()
  }
})

// Review: the manifest was cached on its modification time and size; it is read on every miss.
Deno.test("reads the manifest again on every missing hook route", async () => {
  const first = JSON.stringify({ hooks: { note: { beforeChange: { function: "aaaa" } } } })
  const worker = await workerWithHooks(first)
  try {
    expectEqual(await worker.call("hooks/aaaa"), 503, "mapped in the first manifest")
    const { mtime } = await Deno.stat(worker.manifestPath)
    await Deno.writeTextFile(worker.manifestPath, first.replace("aaaa", "bbbb"))
    if (mtime !== null) await Deno.utime(worker.manifestPath, mtime, mtime)
    expectEqual(await worker.call("hooks/bbbb"), 503, "mapped in a manifest of the same size and time")
  } finally {
    await worker.stop()
  }
})
