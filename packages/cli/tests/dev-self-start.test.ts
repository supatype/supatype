import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEV_APP_ENV, SELF_START_EXIT_CODE, refuseInsideDevApp } from "../src/dev-self-start.js"
import { ProcessManager } from "../src/process-manager.js"

/**
 * The backstop for `supatype dev` running itself as its app by a route dev cannot see in the
 * script (`npm run supatype:dev`, `concurrently`): the copy dev's app starts refuses at once, and
 * the app pane does not restart it.
 */
let dir = ""

afterEach(() => {
  vi.restoreAllMocks()
  if (dir !== "") rmSync(dir, { recursive: true, force: true })
  dir = ""
})

describe("refuseInsideDevApp", () => {
  it("ends a supatype dev that dev started as its app, saying why", () => {
    const written: string[] = []
    const capture = (text: string | Uint8Array): boolean => {
      written.push(String(text))
      return true
    }
    vi.spyOn(process.stdout, "write").mockImplementation(capture)
    vi.spyOn(process.stderr, "write").mockImplementation(capture)
    vi.spyOn(console, "log").mockImplementation((text: string) => void written.push(text))
    vi.spyOn(console, "error").mockImplementation((text: string) => void written.push(text))
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`)
    })
    expect(() => refuseInsideDevApp({ [DEV_APP_ENV]: "1" })).toThrow(`exit ${SELF_START_EXIT_CODE}`)
    expect(exit).toHaveBeenCalledOnce()
    expect(written.join("")).toMatch(/started by supatype dev's own app.*app\.start/s)
  })

  it("lets any other supatype dev run", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    refuseInsideDevApp({})
    expect(exit).not.toHaveBeenCalled()
  })
})

describe("ProcessManager and a final exit code", () => {
  const BACKOFF_MS = 50

  /** A process that prints "ran" and exits with `code`, and how many times it has run. */
  function start(code: number): { proc: ProcessManager; runs: () => number; lines: string[] } {
    dir = mkdtempSync(join(tmpdir(), "supatype-final-exit-"))
    const lines: string[] = []
    const proc = new ProcessManager(process.execPath, ["-e", `console.log("ran"); process.exit(${code})`], {
      label: "app",
      pidDir: dir,
      initialBackoffMs: BACKOFF_MS,
      maxBackoffMs: BACKOFF_MS,
      finalExitCode: SELF_START_EXIT_CODE,
      onLine: (line) => void lines.push(line),
    })
    proc.start()
    return { proc, lines, runs: () => lines.filter((line) => line === "ran").length }
  }

  it("leaves a process that exits with one stopped", async () => {
    const { proc, lines, runs } = start(SELF_START_EXIT_CODE)
    await vi.waitUntil(() => lines.some((line) => line.includes("exited")), { timeout: 5_000 })
    // Long enough for several restarts, had one been scheduled.
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 6))
    await proc.stop()
    expect(runs()).toBe(1)
  }, 10_000)

  it("still restarts a process that fails with any other code", async () => {
    const { proc, runs } = start(1)
    await vi.waitUntil(() => runs() >= 2, { timeout: 5_000 })
    await proc.stop()
  }, 10_000)
})
