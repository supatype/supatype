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

// Native dev rewrites this file when functions.serviceRole changes in supatype.config.ts and reloads
// the worker. The environment is fixed when Deno starts, so a list read from it held the old routes
// until `supatype dev` was restarted.
Deno.test("the routes come from SUPATYPE_SERVICE_ROLE_ROUTES_FILE when it is set", async () => {
  const keyFile = await Deno.makeTempFile()
  const routesFile = await Deno.makeTempFile()
  try {
    await Deno.writeTextFile(keyFile, "from-file\n")
    await Deno.writeTextFile(routesFile, "admin\n")
    const reports = await keyReports({
      SUPATYPE_SERVICE_ROLE_KEY_FILE: keyFile,
      SUPATYPE_SERVICE_ROLE_ROUTES: "hello",
      SUPATYPE_SERVICE_ROLE_ROUTES_FILE: routesFile,
    })
    expectEqual(reports.admin, JSON.stringify({ ctxKey: "from-file", envKey: null }), "admin")
    expectEqual(reports.hello, JSON.stringify({ ctxKey: null, envKey: null }), "hello")
  } finally {
    await Deno.remove(keyFile)
    await Deno.remove(routesFile)
  }
})

// Review r8 A1: a self-hosted deploy sends functions.serviceRole, and the control plane writes it to
// the routes file. The worker read the list once, at start, so a route taken off it kept the key
// until a restart. It reads the file on every call.
Deno.test("a route taken off the routes file loses the key on its next call, with no restart", async () => {
  const keyFile = await Deno.makeTempFile()
  const routesFile = await Deno.makeTempFile()
  await Deno.writeTextFile(keyFile, "from-file\n")
  await Deno.writeTextFile(routesFile, "admin")
  const worker = await startWorker({ admin: REPORTS_KEY }, {
    ...Deno.env.toObject(),
    SUPATYPE_SERVICE_ROLE_KEY_FILE: keyFile,
    SUPATYPE_SERVICE_ROLE_ROUTES_FILE: routesFile,
  })
  try {
    const admin = async (): Promise<string> => JSON.stringify(await (await fetch(`${worker.origin}/functions/v1/admin`)).json())
    expectEqual(await admin(), JSON.stringify({ ctxKey: "from-file", envKey: null }), "admin while listed")
    await Deno.writeTextFile(routesFile, "")
    expectEqual(await admin(), JSON.stringify({ ctxKey: null, envKey: null }), "admin once taken off")
  } finally {
    await worker.stop()
    await Deno.remove(keyFile)
    await Deno.remove(routesFile)
  }
})

// Before the first deploy writes the file, the list compose rendered from the config applies.
Deno.test("a routes file not written yet leaves SUPATYPE_SERVICE_ROLE_ROUTES in force", async () => {
  const keyFile = await Deno.makeTempFile()
  try {
    await Deno.writeTextFile(keyFile, "from-file\n")
    const reports = await keyReports({
      SUPATYPE_SERVICE_ROLE_KEY_FILE: keyFile,
      SUPATYPE_SERVICE_ROLE_ROUTES: "admin",
      SUPATYPE_SERVICE_ROLE_ROUTES_FILE: `${await Deno.makeTempDir()}/not-written-yet`,
    })
    expectEqual(reports.admin, JSON.stringify({ ctxKey: "from-file", envKey: null }), "admin")
    expectEqual(reports.hello, JSON.stringify({ ctxKey: null, envKey: null }), "hello")
  } finally {
    await Deno.remove(keyFile)
  }
})

// Review r9 A-7: the list was read on every call. It is kept until the file's modification time or
// size changes, one stat a call. Shown here by swapping the content for another of the same size and
// putting the time back: the worker still serves the list it read, so it did not read the file again.
Deno.test("an unchanged routes file is not read again on each call", async () => {
  const keyFile = await Deno.makeTempFile()
  const routesFile = await Deno.makeTempFile()
  await Deno.writeTextFile(keyFile, "from-file\n")
  await Deno.writeTextFile(routesFile, "admin")
  const worker = await startWorker({ admin: REPORTS_KEY, hello: REPORTS_KEY }, {
    ...Deno.env.toObject(),
    SUPATYPE_SERVICE_ROLE_KEY_FILE: keyFile,
    SUPATYPE_SERVICE_ROLE_ROUTES_FILE: routesFile,
  })
  try {
    const keyOf = async (name: string): Promise<string> => JSON.stringify(await (await fetch(`${worker.origin}/functions/v1/${name}`)).json())
    expectEqual(await keyOf("admin"), JSON.stringify({ ctxKey: "from-file", envKey: null }), "admin, listed")
    const { mtime } = await Deno.stat(routesFile)
    await Deno.writeTextFile(routesFile, "hello")
    if (mtime !== null) await Deno.utime(routesFile, mtime, mtime)
    expectEqual(await keyOf("hello"), JSON.stringify({ ctxKey: null, envKey: null }), "hello, from a file not read again")
  } finally {
    await worker.stop()
    await Deno.remove(keyFile)
    await Deno.remove(routesFile)
  }
})
