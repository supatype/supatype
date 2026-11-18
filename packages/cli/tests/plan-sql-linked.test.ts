import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MIGRATE_SQL_FEATURE } from "@supatype/shared"
import { projectConfig } from "./support/project-config.js"

/**
 * `push --dry-run` and `diff --sql` on a linked target ask the server for the SQL with
 * `POST /schema/migrate`, and say plainly that the server must be updated when it has no such route.
 */

const SQL = "-- Risk: destructive\nDROP TABLE old_posts;"
const server = vi.hoisted(() => ({
  features: [] as string[],
  calls: [] as { path: string; method: string; body?: unknown }[],
}))

vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { path: string; method: string; body?: unknown }) => {
      server.calls.push({ path: opts.path, method: opts.method, body: opts.body })
      if (opts.path.endsWith("/schema/capabilities")) return { features: server.features }
      if (opts.path.endsWith("/schema/migrate")) return { sql: SQL }
      throw new actual.TargetApiError("Route not found", 404)
    },
  }
})

const { planSqlOrReason } = await import("../src/plan-sql.js")
const { forgetServerCapabilities } = await import("../src/resolve-target.js")

const AST = { models: [{ name: "Note", fields: {} }] }
const migrateCalls = () => server.calls.filter((c) => c.path.endsWith("/schema/migrate"))

let cwd = ""
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-plan-sql-linked-"))
  server.features = []
  server.calls = []
  forgetServerCapabilities()
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

for (const mode of ["cloud", "self-host"] as const) {
  const target = {
    mode,
    environment: "production",
    projectRef: "demo",
    apiBaseUrl: "https://stack.example.test",
    apiPrefix: "/platform/v1",
    token: "key",
    link: null,
  } as const

  describe(`the SQL of a ${mode} target`, () => {
    it("is the server's, asked with the schema and applied to nothing", async () => {
      server.features = [MIGRATE_SQL_FEATURE]
      const answer = await planSqlOrReason({ cwd, config: projectConfig(), target, ast: AST, schema: "app" })
      expect(answer).toEqual({ sql: SQL })
      expect(migrateCalls()).toEqual([
        { path: "/projects/demo/schema/migrate", method: "POST", body: { ast: AST, schema: "app" } },
      ])
      expect(server.calls.some((c) => c.path.endsWith("/schema/push"))).toBe(false)
    })

    it("is not asked of a server that lists no migrate_sql: it is told to update, and no route is called", async () => {
      server.features = ["hook_files"]
      const answer = await planSqlOrReason({ cwd, config: projectConfig(), target, ast: AST, schema: "public" })
      expect(answer.sql).toBeUndefined()
      expect(answer.reason).toMatch(/cannot print the SQL/)
      expect(answer.reason).toMatch(/does not support printing the SQL.*update it/)
      expect(answer.reason).not.toMatch(/404|not found/i)
      expect(migrateCalls()).toEqual([])
    })
  })
}
