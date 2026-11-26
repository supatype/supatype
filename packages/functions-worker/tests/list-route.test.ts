/**
 * The worker's reserved `_functions` route, which the server asks for the project's function list
 * (`GET /functions/v1/_functions`). Without it Studio's Edge Functions page answered "Could not list
 * functions (HTTP 502): functions worker unavailable: it answered 404" on self-host and Docker dev
 * (FF-6). It lists public functions only: a hook is procedural and is no function (S-19, which also
 * kept hook routes out of the `available` names a 404 gives).
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const FUNCTIONS = {
  hello: 'export default () => new Response("hello ok")\n',
  greet: 'export default () => new Response("greet ok")\n',
}

interface Listed {
  name: string
  invocations24h: number
}

/** The `data` array of a function list answer, each entry checked for the fields the page reads. */
function listOf(body: unknown): Listed[] {
  const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined
  if (!Array.isArray(data)) throw new Error("the answer has no data array")
  return data.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || !("invocations24h" in entry)) throw new Error("an entry lacks name or invocations24h")
    if (typeof entry.name !== "string" || typeof entry.invocations24h !== "number") throw new Error("an entry has the wrong types")
    return { name: entry.name, invocations24h: entry.invocations24h }
  })
}

/** The `available` names of a 404 answer. */
function availableOf(body: unknown): string[] {
  const names = typeof body === "object" && body !== null && "available" in body ? body.available : undefined
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string")) throw new Error("the answer has no available names")
  return names
}

async function workerWithHook() {
  const hooksRoot = await Deno.makeTempDir({ prefix: "worker-list-hooks-" })
  await Deno.mkdir(`${hooksRoot}/check-title`)
  await Deno.writeTextFile(`${hooksRoot}/check-title/index.ts`, "export default () => new Response(null, { status: 204 })\n")
  const worker = await startWorker(FUNCTIONS, { ...Deno.env.toObject(), SUPATYPE_HOOKS_ROOT: hooksRoot })
  const stop = async () => {
    await worker.stop()
    await Deno.remove(hooksRoot, { recursive: true })
  }
  return { origin: worker.origin, stop }
}

Deno.test("_functions lists the public functions by name, sorted, and no hook", async () => {
  const worker = await workerWithHook()
  try {
    const res = await fetch(`${worker.origin}/functions/v1/_functions`)
    expectEqual(res.status, 200, "status")
    const body = listOf(await res.json())
    expectEqual(JSON.stringify(body.map((f) => f.name)), JSON.stringify(["greet", "hello"]), "names")
    expectEqual(body[0]?.invocations24h, 0, "invocations24h is a number the page can show")
  } finally {
    await worker.stop()
  }
})

Deno.test("a function that does not exist is a 404 whose available names hold no hook", async () => {
  const worker = await workerWithHook()
  try {
    const res = await fetch(`${worker.origin}/functions/v1/nope`)
    expectEqual(res.status, 404, "status")
    const body = availableOf(await res.json())
    expectEqual(JSON.stringify([...body].sort()), JSON.stringify(["greet", "hello"]), "available")
  } finally {
    await worker.stop()
  }
})
