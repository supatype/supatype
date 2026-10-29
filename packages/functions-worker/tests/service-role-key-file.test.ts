/**
 * The service-role key read from SUPATYPE_SERVICE_ROLE_KEY_FILE, as native `supatype dev` and
 * `supatype functions serve` hand it over: they run this worker under `deno run --watch`, and a
 * reload finds the environment the first evaluation took the key out of.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const REPORTS_KEY = `
export default (_req: Request, ctx: { serviceRoleKey?: string }) =>
  Response.json({ ctxKey: ctx.serviceRoleKey ?? null, envKey: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null })
`

/** What `name` reports about the key, through a worker given `env`. */
async function keyReports(env: Record<string, string>): Promise<{ admin: string; hello: string }> {
  const worker = await startWorker({ admin: REPORTS_KEY, hello: REPORTS_KEY }, { ...Deno.env.toObject(), ...env })
  try {
    const read = async (name: string): Promise<string> =>
      JSON.stringify(await (await fetch(`${worker.origin}/functions/v1/${name}`)).json())
    return { admin: await read("admin"), hello: await read("hello") }
  } finally {
    await worker.stop()
  }
}

Deno.test("the key comes from the file, and only a listed route is given it", async () => {
  const keyFile = await Deno.makeTempFile()
  try {
    await Deno.writeTextFile(keyFile, "from-file\n")
    const reports = await keyReports({
      SUPATYPE_SERVICE_ROLE_KEY: "from-env",
      SUPATYPE_SERVICE_ROLE_KEY_FILE: keyFile,
      SUPATYPE_SERVICE_ROLE_ROUTES: "admin",
    })
    expectEqual(reports.admin, JSON.stringify({ ctxKey: "from-file", envKey: null }), "admin")
    expectEqual(reports.hello, JSON.stringify({ ctxKey: null, envKey: null }), "hello")
  } finally {
    await Deno.remove(keyFile)
  }
})

Deno.test("a key file that cannot be read gives no function the key", async () => {
  const reports = await keyReports({
    SUPATYPE_SERVICE_ROLE_KEY: "from-env",
    SUPATYPE_SERVICE_ROLE_KEY_FILE: `${await Deno.makeTempDir()}/missing`,
    SUPATYPE_SERVICE_ROLE_ROUTES: "admin",
  })
  expectEqual(reports.admin, JSON.stringify({ ctxKey: null, envKey: null }), "admin")
})
