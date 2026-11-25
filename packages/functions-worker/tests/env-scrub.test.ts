/**
 * The worker's process environment as function code sees it (e2e 2026-11-21, RB-2).
 *
 * Native `supatype dev` ran the worker with the server's whole environment, so a function read the
 * stack's JWT secret, the database URL and whatever the developer's shell held through `Deno.env`.
 * The worker now deletes every variable off its allowlist before any function is imported.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const SECRETS = ["JWT_SECRET", "SUPATYPE_JWT_SECRET", "SERVICE_ROLE_KEY", "POSTGRES_PASSWORD", "DATABASE_URL", "SOME_SHELL_VARIABLE"]
const KEPT = ["SUPATYPE_URL", "SUPATYPE_PUBLIC_URL", "SUPATYPE_ANON_KEY", "SITE_URL"]

/** Reports each name in SECRETS and KEPT, read once as the module is imported and again on the call. */
const REPORTS_ENV = `
const names = ${JSON.stringify([...SECRETS, ...KEPT])}
const read = () => Object.fromEntries(names.map((name) => [name, Deno.env.get(name) ?? null]))
const atImport = read()
export default () => Response.json({ atImport, atCall: read() })
`

type Report = Record<string, string | null>

/** The reports route's JSON, narrowed without a cast so a changed shape fails here and says so. */
function reportsOf(body: unknown): { atImport: Report; atCall: Report } {
  if (typeof body === "object" && body !== null && "atImport" in body && "atCall" in body) {
    const { atImport, atCall } = body
    if (isReport(atImport) && isReport(atCall)) return { atImport, atCall }
  }
  throw new Error(`unexpected reports body: ${JSON.stringify(body)}`)
}

function isReport(value: unknown): value is Report {
  return typeof value === "object" && value !== null
}

Deno.test("function code finds no variable off the allowlist in Deno.env, at import or on a call", async () => {
  const env: Record<string, string> = { ...Deno.env.toObject() }
  for (const name of SECRETS) env[name] = "secret"
  for (const name of KEPT) env[name] = `http://kept/${name}`
  const worker = await startWorker({ reports: REPORTS_ENV }, env)
  try {
    const body = reportsOf(await (await fetch(`${worker.origin}/functions/v1/reports`)).json())
    for (const when of ["atImport", "atCall"] as const) {
      for (const name of SECRETS) expectEqual(body[when][name], null, `${name} ${when}`)
      for (const name of KEPT) expectEqual(body[when][name], `http://kept/${name}`, `${name} ${when}`)
    }
  } finally {
    await worker.stop()
  }
})
