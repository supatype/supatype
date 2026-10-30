import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cliModule, runScriptInChild } from "./support/child-script.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Local test round 3b: Ctrl+C during native dev's start reached pg_ctl (or the server's auth
 * migrations) first. The child failed, and dev reported that failure (`✗ pg_ctl start failed
 * (exit 3)`, or a Go stack) before the Ctrl+C itself was handled. Here dev's action fails while a
 * SIGINT is on its way, as the child's exit and the signal arrive on Windows; dev runs in a process
 * of its own, as the command does, and its output and exit code are what is checked.
 */
function interruptedStart(wrapped: boolean): Promise<{ code: number | null; out: string }> {
  const action = "async () => { setImmediate(() => process.emit('SIGINT')); throw new Error('pg_ctl start failed (exit 3)') }"
  const run = wrapped ? `m.stopQuietlyDuringStart(${action})` : `(${action})`
  return runScriptInChild([
    `const m = await import(${cliModule("dev-shutdown.ts")})`,
    "m.ensureDevShutdownHooks()",
    `try { await ${run}() } catch (err) { console.error("✗ " + err.message); process.exit(1) }`,
  ])
}

describe("Ctrl+C during dev's start", () => {
  it("exits quietly with one line saying the start was stopped", async () => {
    const { code, out } = await interruptedStart(true)
    expect(code).toBe(130)
    expect(out.trim()).toBe("[supatype] Stopped during start.")
  }, 30_000)

  // What it replaced, so the test above is known to catch it: the child's failure is reported.
  it("reported the interrupted child's failure without the wrapper", async () => {
    const { out } = await interruptedStart(false)
    expect(out).toContain("✗ pg_ctl start failed (exit 3)")
  }, 30_000)

  // Review of round 3b: the action kept running while the Ctrl+C drained the undo lists, so what it
  // spawned after they were emptied (the server, PostgREST, a late Valkey undo) was never stopped.
  it("stops what the start spawns while the shutdown is under way, and starts nothing after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-late-undo-"))
    dirs.push(dir)
    const mark = JSON.stringify(join(dir, "late-undo-ran"))
    const { code, out } = await runScriptInChild([
      `const m = await import(${cliModule("dev-shutdown.ts")})`,
      "const fs = await import('node:fs')",
      "m.ensureDevShutdownHooks()",
      "const start = m.stopQuietlyDuringStart(async () => {",
      "  m.pushStartUndo(() => new Promise((done) => setTimeout(done, 300)))",
      "  process.emit('SIGINT')",
      "  await new Promise((done) => setTimeout(done, 50))",
      `  m.pushStartUndo(() => fs.writeFileSync(${mark}, 'stopped'))`,
      "  await m.haltIfStopping()",
      "  console.log('started more')",
      "})",
      "await start()",
    ])
    expect(code).toBe(130)
    expect(existsSync(join(dir, "late-undo-ran"))).toBe(true)
    expect(out).not.toContain("started more")
  }, 30_000)

  // Review of round 3b: a start that failed for another reason left Postgres and the services running.
  it("undoes what the start began when it fails for any other reason, then reports the failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-failed-start-"))
    dirs.push(dir)
    const mark = JSON.stringify(join(dir, "postgres-stopped"))
    const { code, out } = await runScriptInChild([
      `const m = await import(${cliModule("dev-shutdown.ts")})`,
      "const fs = await import('node:fs')",
      "m.ensureDevShutdownHooks()",
      "const start = m.stopQuietlyDuringStart(async () => {",
      `  m.pushStartUndoLast(() => fs.writeFileSync(${mark}, 'stopped'))`,
      "  throw new Error('auth migrations failed (exit 1)')",
      "})",
      "try { await start() } catch (err) { console.error('✗ ' + err.message); process.exit(1) }",
    ])
    expect(code).toBe(1)
    expect(out).toContain("✗ auth migrations failed (exit 1)")
    expect(existsSync(join(dir, "postgres-stopped"))).toBe(true)
  }, 30_000)
})
