import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { hostDatabaseUrl, runCli } from "../lib/cli.js"
import { rest } from "../lib/http.js"
import { currentTier, PROJECT_DIR, sql } from "../lib/stack.js"
import { seed, tokenOf } from "../lib/world.js"

/**
 * What only tier 2 has: the base tables behind the `api` views, the views' own options, and the
 * databases that are tier 2 because they are not supatype/postgres at all.
 * Ported from verify-scripts/t2/matrix.mjs (Accept-Profile), T2-N10.sh and T2-N8.sh (T2-N11).
 */
const here = dirname(fileURLToPath(import.meta.url))

if (currentTier() === 2) {
  test.beforeAll(() => seed())

  for (const caller of ["a", "service_role"] as const) {
    test(`${caller} cannot go round the views with Accept-Profile: public`, async () => {
      const r = await rest(tokenOf(caller), "GET", "employee?select=name,salary,ssn", undefined, { "Accept-Profile": "public" })
      expect(r.status, r.text).toBe(406)
    })
  }

  // The dangerous direction: an api view switched back to invoker rights. Restored with RESET, so
  // the view returns to the options the engine gave it.
  test("doctor reports a hand change to an api view's options", () => {
    const url = hostDatabaseUrl()
    try {
      sql("ALTER VIEW api.employee SET (security_invoker = true)")
      const doctor = runCli(["doctor", "--connection", url])
      expect(doctor.output).toMatch(/View employee was changed outside Supatype/)
    } finally {
      sql("ALTER VIEW api.employee RESET (security_invoker)")
    }
  })

  test("a push to a plain Postgres says what is missing", () => {
    test.setTimeout(240_000)
    const port = process.env["MASKING_BYO_PORT"] ?? "55449"
    const container = `${process.env["MASKING_PROJECT_NAME"] ?? "masking"}-byo-pg`
    const dir = join(here, "..", ".state", "byo")
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
    try {
      execFileSync("docker", ["run", "-d", "--name", container, "-p", `127.0.0.1:${port}:5432`,
        "-e", "POSTGRES_PASSWORD=byo", "postgres:17-alpine"], { stdio: "ignore" })
      waitForPostgres(container)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      cpSync(join(PROJECT_DIR, "schema"), join(dir, "schema"), { recursive: true })
      cpSync(join(PROJECT_DIR, "supatype.config.ts"), join(dir, "supatype.config.ts"))
      const push = runCli(["push", "--yes", "--connection", `postgresql://postgres:byo@127.0.0.1:${port}/postgres?sslmode=disable`], dir)
      expect(push.status, push.output).not.toBe(0)
      expect(push.output, "names what to create").toMatch(/create (the )?role|CREATE ROLE/i)
      expect(push.output).not.toMatch(/Recreate the database container/i)
      expect(push.output).not.toContain("18473")
    } finally {
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

function waitForPostgres(container: string): void {
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    // Over TCP: the image's first-start init server listens on the socket only, then restarts.
    const r = spawnSync("docker", ["exec", "-e", "PGPASSWORD=byo", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-c", "select 1"], { stdio: "ignore" })
    if (r.status === 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  throw new Error(`${container} never accepted connections`)
}
