import { describe, expect, it } from "vitest"
import { cliModule, runScriptInChild } from "./support/child-script.js"

/**
 * Run from npm, `supatype dev` runs under a starter that passes every stop signal on, so a Ctrl+C
 * typed in the terminal reaches dev twice: once from the terminal and once from the starter,
 * milliseconds apart. Counted as two presses, the second forced the quit in the middle of the
 * shutdown. A person pressing again to force quit still does.
 *
 * The signals are emitted in the child rather than sent to it, so this runs on Windows too, where
 * a sent SIGINT ends a process outright.
 */

/** A dev whose shutdown takes `workMs`, sent SIGINT twice, `gapMs` apart. */
function devInterruptedTwice(workMs: number, gapMs: number): string[] {
  return [
    `const { registerDevShutdown } = await import(${cliModule("dev-shutdown.ts")})`,
    `registerDevShutdown(async () => { await new Promise((r) => setTimeout(r, ${workMs})); console.log("shutdown work ran") })`,
    `setInterval(() => undefined, 1000)`,
    `process.emit("SIGINT", "SIGINT")`,
    `setTimeout(() => process.emit("SIGINT", "SIGINT"), ${gapMs})`,
  ]
}

describe("a Ctrl+C that reaches dev twice", () => {
  it("is one press when the two arrive together", async () => {
    const { code, out } = await runScriptInChild(devInterruptedTwice(1_000, 20))
    expect(out).toContain("shutdown work ran")
    expect(out).not.toContain("Forced quit")
    expect(code).toBe(0)
  }, 30_000)

  it("still forces the quit when pressed again", async () => {
    const { code, out } = await runScriptInChild(devInterruptedTwice(3_000, 800))
    expect(out).toContain("Forced quit")
    expect(out).not.toContain("shutdown work ran")
    expect(code).toBe(130)
  }, 30_000)
})
