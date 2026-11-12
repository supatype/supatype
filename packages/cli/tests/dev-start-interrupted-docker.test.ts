import { describe, expect, it } from "vitest"
import { cliModule, runScriptInChild } from "./support/child-script.js"

/**
 * 0.9.1 release test, FF11: Docker dev registers the compose stack's stop as its start begins, so a
 * Ctrl+C during "Starting Postgres" ran the shutdown of a running dev: `Shutting down…`, then exit 0.
 * Native dev says `Stopped during start.` and exits 130; Docker dev now does the same, and still
 * stops the stack. The signal is emitted in the child, so this runs on Windows too.
 */
function dockerDev(finishStart: boolean): string[] {
  return [
    `const m = await import(${cliModule("dev-shutdown.ts")})`,
    'm.registerDevShutdown(async () => { console.log("compose stack stopped") }, { duringStart: true })',
    ...(finishStart ? ["void m.waitForDevShutdown()"] : ["setInterval(() => undefined, 1000)"]),
    'process.emit("SIGINT", "SIGINT")',
  ]
}

describe("Ctrl+C during Docker dev's start", () => {
  it("says the start was stopped, stops the stack, and exits 130", async () => {
    const { code, out } = await runScriptInChild(dockerDev(false))
    expect(out).toContain("[supatype] Stopped during start.")
    expect(out).not.toContain("Shutting down…")
    expect(out).toContain("compose stack stopped")
    expect(code).toBe(130)
  }, 30_000)

  it("shuts down as a running dev, exit 0, once the start has finished", async () => {
    const { code, out } = await runScriptInChild(dockerDev(true))
    expect(out).toContain("[supatype] Shutting down…")
    expect(out).not.toContain("Stopped during start.")
    expect(out).toContain("compose stack stopped")
    expect(code).toBe(0)
  }, 30_000)
})
