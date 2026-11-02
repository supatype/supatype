import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  installDependencies,
  plainStepView,
  runTimedStep,
  spinnerStepView,
  type InstallCommand,
} from "../src/init-setup-steps.js"

/**
 * Local test round 3, N6: init's install ran through `spawnSync`, which blocked the event loop for
 * the whole install. The interactive spinner froze, and the Docker probe's 5 s timer fired before
 * Docker's answer could be read, so every init with install said the daemon was not running.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-init-steps-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for `npm install`: node, printing `lines` after `waitMs`, then exiting with `code`. */
function fakeInstall(waitMs: number, lines: string[], code = 0): InstallCommand {
  const script = `setTimeout(() => { for (const l of ${JSON.stringify(lines)}) console.log(l); process.exit(${code}) }, ${waitMs})`
  return { file: process.execPath, args: ["-e", script], shell: false }
}

describe("installDependencies", () => {
  it("leaves the event loop free while the install runs", async () => {
    const order: string[] = []
    setTimeout(() => order.push("timer"), 50)
    await installDependencies(dir, fakeInstall(1_000, []))
    order.push("installed")
    expect(order).toEqual(["timer", "installed"])
  })

  it("hands each output line to the caller, without colour codes", async () => {
    const seen: string[] = []
    const ok = await installDependencies(dir, fakeInstall(0, ["\u001b[32madded 3 packages\u001b[0m", "", "done"]), (line) => seen.push(line))
    expect(ok).toBe(true)
    expect(seen).toEqual(["added 3 packages", "done"])
  })

  it("reports a failed install, and prints what it said last", async () => {
    const printed: string[] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")))
    const ok = await installDependencies(dir, fakeInstall(0, ["npm ERR! code E404"], 1), () => undefined)
    expect(ok).toBe(false)
    expect(printed.join("\n")).toContain("npm ERR! code E404")
  })
})

/** A clock that moves only when told. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000
  return { now: () => at, advance: (ms) => void (at += ms) }
}

describe("runTimedStep", () => {
  it("prints a start line and a done line with its time when there is no terminal", async () => {
    const lines: string[] = []
    const time = clock()
    const step = { label: "Installing dependencies with npm", run: async () => (time.advance(14_200), true), done: () => "Dependencies installed" }
    await runTimedStep(plainStepView((line) => lines.push(line)), step, time.now)
    expect(lines).toEqual(["Installing dependencies with npm...", "Dependencies installed (14.2s)"])
  })

  it("keeps a terminal's spinner counting, with the latest output line under it", async () => {
    vi.useFakeTimers()
    try {
      const shown: string[] = []
      const spinner = { start: (text: string) => shown.push(text), stop: (text: string) => shown.push(`stop: ${text}`) }
      const step = {
        label: "Installing dependencies with npm",
        run: async (detail: (line: string) => void) => {
          await vi.advanceTimersByTimeAsync(13_500)
          detail("added 120 packages in 13s")
          await vi.advanceTimersByTimeAsync(500)
          return true
        },
        done: () => "Dependencies installed",
      }
      await runTimedStep(spinnerStepView(spinner), step, () => Date.now())
      expect(shown).toContain("Installing dependencies with npm... 14s\n  added 120 packages in 13s")
      expect(shown.at(-1)).toBe("stop: Dependencies installed (14.0s)")
    } finally {
      vi.useRealTimers()
    }
  })

  // npm can print hundreds of lines a second, and each one redrew the spinner. A line is kept and
  // drawn at the next tick, with whatever came after it.
  it("draws output lines at the next tick, not one redraw per line", async () => {
    vi.useFakeTimers()
    try {
      const shown: string[] = []
      const spinner = { start: (text: string) => shown.push(text), stop: () => undefined }
      const step = {
        label: "Installing",
        run: async (detail: (line: string) => void) => {
          for (let i = 0; i < 50; i += 1) detail(`line ${i}`)
          await vi.advanceTimersByTimeAsync(1_000)
          return true
        },
        done: () => "Done",
      }
      await runTimedStep(spinnerStepView(spinner), step, () => Date.now())
      expect(shown).toEqual(["Installing...", "Installing... 1s\n  line 49"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("redraws every second while the step is quiet", async () => {
    vi.useFakeTimers()
    try {
      const shown: string[] = []
      const spinner = { start: (text: string) => shown.push(text), stop: () => undefined }
      const step = { label: "Installing", run: () => vi.advanceTimersByTimeAsync(3_000).then(() => true), done: () => "Done" }
      await runTimedStep(spinnerStepView(spinner), step, () => Date.now())
      expect(shown).toEqual(["Installing...", "Installing... 1s", "Installing... 2s", "Installing... 3s"])
    } finally {
      vi.useRealTimers()
    }
  })
})
