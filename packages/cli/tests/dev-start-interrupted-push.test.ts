import { describe, expect, it } from "vitest"
import { cliModule, runScriptInChild } from "./support/child-script.js"

/**
 * Local test round 3c (N16): Ctrl+C while native dev's start ran the first schema push. The engine
 * failed from the same Ctrl+C, and dev printed `Schema push failed: ...` (sometimes with nothing
 * after the colon) before `Stopped during start.`. Here the push fails while a SIGINT is on its way,
 * and dev runs in a process of its own, as the command does.
 */
function interruptedPush(quiet: boolean): Promise<{ code: number | null; out: string }> {
  const report = quiet ? "m.reportUnlessStopping(r.reportDevPushFailure)" : "r.reportDevPushFailure"
  return runScriptInChild([
    `const m = await import(${cliModule("dev-shutdown.ts")})`,
    `const r = await import(${cliModule("push-refusal.ts")})`,
    "m.ensureDevShutdownHooks()",
    "const start = m.stopQuietlyDuringStart(async () => {",
    "  setImmediate(() => process.emit('SIGINT'))",
    `  await Promise.reject(new Error('engine exited 1')).catch(${report})`,
    "  await m.haltIfStopping()",
    "})",
    "await start()",
  ])
}

describe("Ctrl+C during dev's first schema push", () => {
  it("exits with one line saying the start was stopped, and no push failure", async () => {
    const { code, out } = await interruptedPush(true)
    expect(code).toBe(130)
    expect(out.trim()).toBe("[supatype] Stopped during start.")
  }, 30_000)

  // What it replaced, so the test above is known to catch it.
  it("reported the push failure before the stop without the guard", async () => {
    const { out } = await interruptedPush(false)
    expect(out).toContain("Schema push failed: engine exited 1")
  }, 30_000)

  it("still reports a push failure when no shutdown began", async () => {
    const { code, out } = await runScriptInChild([
      `const m = await import(${cliModule("dev-shutdown.ts")})`,
      `const r = await import(${cliModule("push-refusal.ts")})`,
      "await Promise.reject(new Error('engine exited 1')).catch(m.reportUnlessStopping(r.reportDevPushFailure))",
    ])
    expect(code).toBe(0)
    expect(out).toContain("Schema push failed: engine exited 1")
  }, 30_000)
})
