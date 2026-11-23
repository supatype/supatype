/**
 * A function's `ctx.env`, read from the functions root's `.env.local` and `.env.<function>.local`,
 * the way the CLI and compose read a `.env`: one pair of enclosing quotes stripped, `#` comments
 * and inline comments dropped, an optional `export `. The worker used to keep the quotes, so
 * `KEY="value"` reached a function as `"value"` here and as `value` everywhere else.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const REPORTS_ENV = `
export default (_req: Request, ctx: { env: Record<string, string> }) => Response.json(ctx.env)
`

const ENV_LOCAL = [
  "# a comment",
  'DOUBLE="double # kept"',
  "SINGLE='single'",
  "export EXPORTED=yes",
  "INLINE=value  # dropped",
  "PLAIN=a#b",
  "",
].join("\n")

Deno.test("ctx.env reads .env.local the way the CLI and compose do", async () => {
  const sharedEnv = `${await Deno.makeTempDir()}/.env.local`
  await Deno.writeTextFile(sharedEnv, ENV_LOCAL)
  const worker = await startWorker({ reports: REPORTS_ENV }, { ...Deno.env.toObject(), SUPATYPE_SHARED_ENV_FILE: sharedEnv })
  try {
    const env = await (await fetch(`${worker.origin}/functions/v1/reports`)).json()
    expectEqual(
      JSON.stringify(env),
      JSON.stringify({ DOUBLE: "double # kept", SINGLE: "single", EXPORTED: "yes", INLINE: "value", PLAIN: "a#b" }),
      "ctx.env",
    )
  } finally {
    await worker.stop()
  }
})

// Review: `functions env set` on self-host wrote .supatype/function-env.json, which the worker never
// read, so a value set never reached a function. The worker reads it, as compose names it, on every
// call: a value set is seen, and one unset is gone, with no restart between.
Deno.test("ctx.env carries what functions env set wrote, and loses what unset removed", async () => {
  const managed = `${await Deno.makeTempDir()}/function-env.json`
  await Deno.writeTextFile(managed, JSON.stringify({ API_KEY: "set" }))
  const worker = await startWorker({ reports: REPORTS_ENV }, { ...Deno.env.toObject(), SUPATYPE_FUNCTION_ENV_FILE: managed })
  try {
    const envNow = async (): Promise<string> => JSON.stringify(await (await fetch(`${worker.origin}/functions/v1/reports`)).json())
    expectEqual(await envNow(), JSON.stringify({ API_KEY: "set" }), "ctx.env after set")
    await Deno.writeTextFile(managed, JSON.stringify({}))
    expectEqual(await envNow(), JSON.stringify({}), "ctx.env after unset")
  } finally {
    await worker.stop()
  }
})

// D-72: Cloud hands the worker one file per function beside the shared one, `fn.<name>.json` in the
// directory of SUPATYPE_FUNCTION_ENV_FILE. The function's own values win over the shared ones, for
// that function only, and both are read on every call.
Deno.test("ctx.env merges fn.<name>.json over the managed values, for that function only", async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(`${dir}/env.json`, JSON.stringify({ SHARED: "s", BOTH: "shared" }))
  await Deno.writeTextFile(`${dir}/fn.reports.json`, JSON.stringify({ OWN: "mine", BOTH: "own" }))
  await Deno.writeTextFile(`${dir}/fn.other.json`, JSON.stringify({ THEIRS: "theirs" }))
  const worker = await startWorker(
    { reports: REPORTS_ENV, other: REPORTS_ENV, plain: REPORTS_ENV },
    { ...Deno.env.toObject(), SUPATYPE_FUNCTION_ENV_FILE: `${dir}/env.json` },
  )
  try {
    const envOf = async (fn: string): Promise<string> => JSON.stringify(await (await fetch(`${worker.origin}/functions/v1/${fn}`)).json())
    expectEqual(await envOf("reports"), JSON.stringify({ SHARED: "s", BOTH: "own", OWN: "mine" }), "reports")
    expectEqual(await envOf("other"), JSON.stringify({ SHARED: "s", BOTH: "shared", THEIRS: "theirs" }), "other")
    expectEqual(await envOf("plain"), JSON.stringify({ SHARED: "s", BOTH: "shared" }), "a function with no file of its own")
    await Deno.writeTextFile(`${dir}/fn.reports.json`, JSON.stringify({}))
    expectEqual(await envOf("reports"), JSON.stringify({ SHARED: "s", BOTH: "shared" }), "reports after its own values are unset")
    await Deno.remove(`${dir}/fn.reports.json`)
    expectEqual(await envOf("reports"), JSON.stringify({ SHARED: "s", BOTH: "shared" }), "reports with its file gone")
  } finally {
    await worker.stop()
  }
})

Deno.test("ctx.env reads a function's own file with no shared file at all", async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(`${dir}/fn.reports.json`, JSON.stringify({ OWN: "mine" }))
  const worker = await startWorker({ reports: REPORTS_ENV }, { ...Deno.env.toObject(), SUPATYPE_FUNCTION_ENV_FILE: `${dir}/env.json` })
  try {
    const env = await (await fetch(`${worker.origin}/functions/v1/reports`)).json()
    expectEqual(JSON.stringify(env), JSON.stringify({ OWN: "mine" }), "ctx.env")
  } finally {
    await worker.stop()
  }
})
