import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ProcessManager } from "../src/process-manager.js"

/**
 * Stopping a process that had already exited waited for an "exit" event that had come and gone,
 * so it took the full five-second grace period. Native dev stops realtime that way when realtime
 * exits as it starts, which held dev's start up by five seconds for nothing.
 */
let dir = ""

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("ProcessManager.stop", () => {
  it("returns at once for a process that has already exited", async () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-pm-stop-"))
    let exited: () => void = () => undefined
    const gone = new Promise<void>((resolve) => {
      exited = resolve
    })
    const proc = new ProcessManager(process.execPath, ["-e", "process.exit(0)"], {
      label: "quick",
      pidDir: dir,
      onExit: () => exited(),
    })
    proc.start()
    await gone
    const began = Date.now()
    await proc.stop()
    expect(Date.now() - began).toBeLessThan(1_000)
  }, 10_000)
})
