/**
 * A function that fails to load, through the real worker. The worker imported every function at
 * start and stopped at the first that failed, so one broken module took every function down.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const FUNCTIONS = {
  empty: "export const other = 1\n",
  syntax: "export default (\n",
  throws: 'throw new Error("boom-at-import")\n',
  missing: 'import "./not-here.ts"\nexport default () => new Response("unreachable")\n',
  hello: 'export default () => new Response("hello ok")\n',
}

/** The route's status and body, the body parsed when it is JSON. */
async function call(origin: string, name: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}/functions/v1/${name}`)
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}

Deno.test("a function that failed to load answers 500 with why, and the others still serve", async () => {
  const worker = await startWorker(FUNCTIONS, Deno.env.toObject())
  try {
    expectEqual((await call(worker.origin, "hello")).body, "hello ok", "hello")
    const failures: Record<string, RegExp> = {
      empty: /^Function "empty" failed to load: .*neither a default export nor a named "handler"/s,
      syntax: /^Function "syntax" failed to load: /,
      throws: /^Function "throws" failed to load: .*boom-at-import/s,
      // Deno colours the importing file's location in this message, piped or not, and a JSON body
      // carried the escape codes to every client.
      missing: /^Function "missing" failed to load: Module not found [^\u001b]*$/s,
    }
    for (const [name, pattern] of Object.entries(failures)) {
      const { status, body } = await call(worker.origin, name)
      expectEqual(status, 500, `${name} status`)
      if (typeof body !== "object" || body === null || !("error" in body) || !("message" in body)) {
        throw new Error(`${name}: unexpected body ${JSON.stringify(body)}`)
      }
      expectEqual(body.error, "function_load_failed", `${name} error`)
      if (!pattern.test(String(body.message))) throw new Error(`${name}: message ${JSON.stringify(body.message)}`)
    }
  } finally {
    await worker.stop()
  }
})

// A handler that throws while serving answers 500 with its message as JSON, which a client has no
// terminal to colour, so escape codes come out of it as they do from a load failure's. Native dev
// ran a generated router that did this; it now runs this worker, which must do the same.
Deno.test("a handler that throws answers with its message, without escape codes", async () => {
  const fails = 'export default () => { throw new Error("\u001b[31mboom\u001b[0m at work") }\n'
  const worker = await startWorker({ fails }, Deno.env.toObject())
  try {
    const { status, body } = await call(worker.origin, "fails")
    expectEqual(status, 500, "status")
    expectEqual(JSON.stringify(body), JSON.stringify({ error: "function_error", message: "boom at work" }), "body")
  } finally {
    await worker.stop()
  }
})
