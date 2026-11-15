import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.mock("../src/self-host-compose.js", () => ({ runDockerCompose: vi.fn(() => 0) }))

import {
  restartComposeFunctionsWorker,
  waitForWorkerHealth,
  watchFunctionSources,
  type WatchFn,
  type WorkerHealthDeps,
} from "../src/dev-functions-watch.js"

/** A function copied in as a folder, and a restart that is reported only once the worker answers. */
type Listener = (event: string, filename: string | null) => void

let project: string
let listeners: Map<string, Listener>

const fakeWatch: WatchFn = (dir, _options, listener) => {
  listeners.set(dir, listener)
  return { close: () => undefined }
}

beforeEach(() => {
  vi.useFakeTimers()
  project = mkdtempSync(join(tmpdir(), "functions-restart-"))
  mkdirSync(join(project, "functions"), { recursive: true })
  listeners = new Map()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(project, { recursive: true, force: true })
})

describe("what restarts the worker", () => {
  it("restarts when a folder with no extension is copied in", () => {
    mkdirSync(join(project, "functions", "issue-ticket"))
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    listeners.get(join(project, "functions"))?.("rename", "issue-ticket")
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("restarts when a folder is deleted, which no longer exists to be checked", () => {
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    listeners.get(join(project, "functions"))?.("rename", "gone-function")
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("still ignores env files and plain non-source files", () => {
    writeFileSync(join(project, "functions", ".env.local"), "A=1")
    writeFileSync(join(project, "functions", "notes.md"), "x")
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    listeners.get(join(project, "functions"))?.("change", ".env.local")
    listeners.get(join(project, "functions"))?.("change", "notes.md")
    vi.advanceTimersByTime(500)
    expect(restart).not.toHaveBeenCalled()
  })
})

function healthDeps(statuses: Array<number | "down">): WorkerHealthDeps & { now: () => number } {
  let clock = 0
  const queue = [...statuses]
  return {
    fetchStatus: async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!
      if (next === "down") throw new Error("ECONNREFUSED")
      return next
    },
    sleep: async (ms) => { clock += ms },
    now: () => clock,
  }
}

const target = { composePath: "c.yml", cwd: ".", project: "p", baseUrl: "http://localhost:8000", anonKey: "anon" }

describe("the restart report", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it("waits through a stopped worker and answers true once it responds", async () => {
    expect(await waitForWorkerHealth(target, healthDeps(["down", 502, 404]))).toBe(true)
  })

  it("gives up when the worker never answers", async () => {
    expect(await waitForWorkerHealth(target, healthDeps([503]), 2_000)).toBe(false)
  })

  it("says restarted only after the health check passes", async () => {
    await restartComposeFunctionsWorker(target, healthDeps(["down", 404]))
    const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0]))
    expect(said.some((l) => l.includes("Functions worker restarted"))).toBe(true)
  })

  it("does not say restarted when the worker never comes back", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0)
    const deps = healthDeps([503])
    await restartComposeFunctionsWorker(target, { ...deps, now: (() => { let t = 0; return () => (t += 40_000) })() })
    const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0]))
    expect(said.some((l) => l.includes("Functions worker restarted"))).toBe(false)
    expect(vi.mocked(console.warn).mock.calls.join(" ")).toContain("not answering")
  })
})
