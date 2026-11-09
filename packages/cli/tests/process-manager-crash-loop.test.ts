import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FAST_CRASH_LIMIT, ProcessManager, type ProcessOptions } from "../src/process-manager.js"

/**
 * A service that crashed as it started was restarted for ever, so one that could never start (a
 * bad script, a missing file) filled its pane with the same error until dev was stopped. After a
 * run of quick crashes it is left stopped, and a run that lasted starts the count and the wait over.
 */
let dir = ""
let proc: ProcessManager | undefined

afterEach(async () => {
  await proc?.stop()
  proc = undefined
  rmSync(dir, { recursive: true, force: true })
})

interface Crashing {
  lines: string[]
  runs: () => number
  /** How many times the manager said the process has stopped for good. */
  stops: () => number
}

/** A process that prints "ran", waits `livesMs`, then exits 1. */
function crashing(livesMs: number, opts: Partial<ProcessOptions> = {}): Crashing {
  dir = mkdtempSync(join(tmpdir(), "supatype-crash-loop-"))
  const lines: string[] = []
  let stops = 0
  const script = `console.log("ran"); setTimeout(() => process.exit(1), ${livesMs})`
  proc = new ProcessManager(process.execPath, ["-e", script], {
    label: "svc",
    pidDir: dir,
    initialBackoffMs: 20,
    maxBackoffMs: 1_000,
    onLine: (line) => void lines.push(line),
    onStopped: () => void stops++,
    ...opts,
  })
  proc.start()
  return { lines, runs: () => lines.filter((line) => line === "ran").length, stops: () => stops }
}

describe("ProcessManager and a process that keeps crashing", () => {
  // Waits of 20 and 40ms, then 50 (the cap) until the limit, then 100 and 200 past the cap. The
  // next would be 400, past the 300 at which it gives up.
  it("retries less often after the limit of quick crashes, then stops once the wait reaches the give-up", async () => {
    const { lines, runs, stops } = crashing(0, { maxBackoffMs: 50, giveUpWaitMs: 300 })
    const stopLine = () => lines.find((line) => line.includes("not restarting it"))
    await vi.waitUntil(stopLine, { timeout: 8_000 })
    const waits = lines.filter((line) => line.includes("restarting in")).map((line) => line.replace(/.*restarting in /, ""))
    expect(waits).toEqual(["20ms", "40ms", "50ms", "50ms", "50ms", "100ms", "200ms"])
    expect(lines.filter((line) => line.includes("retried less often"))).toEqual([
      `it has exited ${FAST_CRASH_LIMIT} times in a row within 5s of starting, so it is retried less often`,
    ])
    expect(stopLine()).toMatch(/still crashing as it starts, not restarting it\. Fix the error above, then restart supatype dev\./)
    expect(stops()).toBe(1)
    // The last run's output can arrive after its exit.
    await vi.waitUntil(() => runs() === 8, { timeout: 2_000 })
  }, 10_000)

  it("keeps restarting one that runs a while before each crash, waiting the shortest time each time", async () => {
    const { lines, runs, stops } = crashing(250, { fastCrashMs: 100 })
    await vi.waitUntil(() => runs() > FAST_CRASH_LIMIT, { timeout: 8_000 })
    const waits = lines.filter((line) => line.includes("restarting in"))
    expect(waits.every((line) => line.endsWith("restarting in 20ms"))).toBe(true)
    expect(stops()).toBe(0)
  }, 10_000)
})
