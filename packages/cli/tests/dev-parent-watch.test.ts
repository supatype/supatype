import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as watch from "../src/parent-watch.js"

// `supatype dev` started by a script that is then killed outright (SIGKILL, a CI job cancelled, a
// tool timeout) used to run on, and so did its stack, holding the ports and the compose project
// until someone found it. It now notices that the process that started it is gone and stops the
// way Ctrl+C stops it.

const DEV_SHUTDOWN = pathToFileURL(join(import.meta.dirname, "../src/dev-shutdown.ts")).href

interface FakeProbe {
  ppid: number
  dead: Set<number>
}

function probeOf(state: FakeProbe): watch.ProcessProbe {
  return { ppid: () => state.ppid, alive: (pid) => !state.dead.has(pid) }
}

describe("watchParent()", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("stays quiet while the parent is alive", () => {
    const state: FakeProbe = { ppid: 4000, dead: new Set() }
    const onGone = vi.fn()
    watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    vi.advanceTimersByTime(10_000)
    expect(onGone).not.toHaveBeenCalled()
  })

  it("fires when the parent dies", () => {
    const state: FakeProbe = { ppid: 4000, dead: new Set() }
    const onGone = vi.fn()
    watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    state.dead.add(4000)
    vi.advanceTimersByTime(1000)
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it("fires when the process is handed to a new parent (Linux and macOS reparent orphans)", () => {
    const state: FakeProbe = { ppid: 4000, dead: new Set() }
    const onGone = vi.fn()
    watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    state.ppid = 1
    vi.advanceTimersByTime(1000)
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it("fires when a further ancestor it was asked to watch dies", () => {
    const state: FakeProbe = { ppid: 4000, dead: new Set() }
    const onGone = vi.fn()
    const w = watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    w.watchAlso(3000)
    state.dead.add(3000)
    vi.advanceTimersByTime(1000)
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it("fires once, however long the parent stays gone", () => {
    const state: FakeProbe = { ppid: 4000, dead: new Set([4000]) }
    const onGone = vi.fn()
    watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    vi.advanceTimersByTime(10_000)
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it("watches nothing when it starts without a parent to lose", () => {
    const state: FakeProbe = { ppid: 1, dead: new Set([1]) }
    const onGone = vi.fn()
    watch.watchParent(onGone, { probe: probeOf(state), intervalMs: 1000 })
    vi.advanceTimersByTime(10_000)
    expect(onGone).not.toHaveBeenCalled()
  })
})

describe("pidAlive()", () => {
  it("is true for this process and false for one that has exited", async () => {
    expect(watch.pidAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    const pid = child.pid ?? 0
    await new Promise((resolve) => child.on("exit", resolve))
    expect(watch.pidAlive(pid)).toBe(false)
  })
})

/**
 * The real thing: a parent process starts the end of `dev`, then is killed outright. The dev tail
 * must run its shutdown work (the compose down) and exit within a few seconds.
 */
describe("dev when the process that started it is killed", () => {
  it("runs its shutdown work and exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-dev-orphan-"))
    const marker = join(dir, "shutdown-ran")
    const pidFile = join(dir, "dev-pid")
    const devTail = join(dir, "dev-tail.mjs")
    writeFileSync(
      devTail,
      [
        'import { writeFileSync } from "node:fs"',
        "void (async () => {",
        `  const { registerDevShutdown, waitForDevShutdown } = await import(${JSON.stringify(DEV_SHUTDOWN)})`,
        `  registerDevShutdown(async () => { writeFileSync(${JSON.stringify(marker)}, "yes") })`,
        `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
        "  await waitForDevShutdown()",
        "})()",
        "",
      ].join("\n"),
    )
    // The starter stands in for a shell script. `detached` because a shell leaves its children
    // running when it dies; a plain Node child on Windows sits in its parent's job object and is
    // killed with it, before any shutdown work could run.
    const starter = join(dir, "starter.mjs")
    writeFileSync(
      starter,
      [
        'import { spawn } from "node:child_process"',
        `spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(devTail)}], { stdio: "ignore", detached: true })`,
        "setInterval(() => undefined, 1000)",
        "",
      ].join("\n"),
    )
    const parent = spawn(process.execPath, [starter], {
      cwd: join(import.meta.dirname, ".."),
      stdio: "ignore",
    })
    await waitFor(() => existsSync(pidFile), 30_000)
    const devPid = Number(readFileSync(pidFile, "utf8"))
    parent.kill("SIGKILL")

    const stopped = await waitFor(() => existsSync(marker) && !watch.pidAlive(devPid), 15_000)
    if (!stopped && watch.pidAlive(devPid)) process.kill(devPid, "SIGKILL")
    expect(existsSync(marker), "the shutdown work ran").toBe(true)
    expect(watch.pidAlive(devPid), "dev exited").toBe(false)
  }, 60_000)
})

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return check()
}
