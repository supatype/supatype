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
