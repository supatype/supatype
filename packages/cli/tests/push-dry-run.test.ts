import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DiffResult } from "../src/engine-client.js"
import { runCommand } from "./support/command-run.js"
import { directTarget } from "./support/deploy-target.js"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype push --dry-run` and `supatype diff --sql` print the SQL a push would apply, from the
 * engine's `/migrate` as `supatype migrate` does. A dry run applies nothing, asks nothing and
 * records nothing.
 */

const SQL = "-- Risk: destructive\nDROP TABLE old_posts;"
const engine = vi.hoisted((): { calls: { endpoint: string; body: Record<string, unknown> }[]; diff: DiffResult } => ({
  calls: [],
  diff: { operations: [] },
}))

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => undefined,
  engineRequest: async (endpoint: string, body: Record<string, unknown>) => {
    engine.calls.push({ endpoint, body })
    return endpoint === "/migrate" ? { message: SQL } : endpoint === "/diff" ? engine.diff : { status: "ok" }
  },
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig(),
  loadSchemaAst: () => ({ version: 2, models: [] }),
}))
vi.mock("../src/local-stack-guard.js", () => ({ requireLocalStack: () => undefined }))
vi.mock("../src/engine-floor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-floor.js")>()),
  assertEngineSupportsSchema: () => undefined,
}))
vi.mock("../src/byo-preflight.js", () => ({ byoPreflight: async () => [] }))
// The push asks Docker whether this project's stack runs. A CI runner has no Docker to ask (macOS
// and Windows), and no stack runs for this project either way.
vi.mock("../src/compose-render-mode.js", async (importOriginal) =>
  (await import("./support/no-running-stack.js")).withNoRunningStack(await importOriginal<typeof import("../src/compose-render-mode.js")>()))
vi.mock("../src/engine-ownership-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-ownership-gate.js")>()),
  engineCapabilities: async () => ({ features: [], schema: 99 }),
  assertSupported: () => undefined,
}))
vi.mock("../src/host-database.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host-database.js")>()),
  resolveHostDatabaseUrl: () => ({ dsn: "postgres://u:p@localhost:5432/demo" }),
}))

const { registerPush } = await import("../src/commands/push.js")
const { registerDiff } = await import("../src/commands/diff.js")

let cwd = ""
const DSN = ["--connection", "postgres://u:p@localhost:5432/demo"]
const endpoints = () => engine.calls.map((c) => c.endpoint)

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-dry-run-"))
  engine.calls = []
  engine.diff = { operations: [{ type: "drop_table", table: "old_posts", risk: "destructive" }] }
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  process.exitCode = undefined
})

describe("supatype push --dry-run", () => {
  it("prints the change list and the SQL, and calls no push", async () => {
    const run = await runCommand(registerPush, ["push", "--dry-run", ...DSN], cwd)
    expect(run.output).toContain("drop_table old_posts")
    expect(run.output).toContain(SQL)
    expect(endpoints()).toEqual(["/diff", "/migrate"])
    expect(run.exitCode).toBeUndefined()
    expect(process.exitCode).toBeUndefined()
  })

  it("lets the engine write a destructive change without --yes or --force", async () => {
    await runCommand(registerPush, ["push", "--dry-run", ...DSN], cwd)
    expect(engine.calls.find((c) => c.endpoint === "/migrate")?.body["force"]).toBe(true)
    expect(engine.calls.find((c) => c.endpoint === "/migrate")?.body["record"]).toBe(false)
  })

  it("says there is no SQL to run when nothing changes", async () => {
    engine.diff = { operations: [] }
    const run = await runCommand(registerPush, ["push", "--dry-run", ...DSN], cwd)
    expect(run.output).toContain("no SQL to run")
    expect(endpoints()).toEqual(["/diff"])
  })
})

describe("supatype diff --sql", () => {
  it("prints the change list, then the SQL", async () => {
    const run = await runCommand(registerDiff, ["diff", "--sql", ...DSN], cwd)
    expect(run.output.indexOf("drop_table old_posts")).toBeLessThan(run.output.indexOf(SQL))
    expect(endpoints()).toEqual(["/diff", "/migrate"])
  })

  it("prints no SQL without --sql", async () => {
    const run = await runCommand(registerDiff, ["diff", ...DSN], cwd)
    expect(run.output).not.toContain(SQL)
    expect(endpoints()).toEqual(["/diff"])
  })

  it("says there is no SQL to run when nothing changes", async () => {
    engine.diff = { operations: [] }
    const run = await runCommand(registerDiff, ["diff", "--sql", ...DSN], cwd)
    expect(run.output).toContain("no SQL to run")
    expect(endpoints()).toEqual(["/diff"])
  })
})
