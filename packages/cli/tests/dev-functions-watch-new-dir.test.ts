import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchFunctionSources, type WatchFn } from "../src/dev-functions-watch.js"

/**
 * Fresh-user test C6: `supatype dev` did not load a function created while it ran, and editing the
 * file afterwards did not help either. The watch was set up only on the source directories that
 * existed when dev started, so in a project with no functions/ yet, `supatype functions new` made a
 * directory nothing watched. The project root is watched for functions/ and hooks/ appearing.
 */
type Listener = (event: string, filename: string | null) => void

let project: string
let listeners: Map<string, Listener>

const fakeWatch: WatchFn = (dir, _options, listener) => {
  listeners.set(dir, listener)
  return { close: () => listeners.delete(dir) }
}

beforeEach(() => {
  vi.useFakeTimers()
  project = mkdtempSync(join(tmpdir(), "functions-watch-new-"))
  listeners = new Map()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(project, { recursive: true, force: true })
})

describe("dev's functions watch, for a directory made after dev started", () => {
  it("restarts the worker when functions/ appears, and watches it from then on", () => {
    const restart = vi.fn()
    const watcher = watchFunctionSources(project, restart, fakeWatch)
    expect(listeners.has(join(project, "functions"))).toBe(false)

    mkdirSync(join(project, "functions", "hello"), { recursive: true })
    listeners.get(project)?.("rename", "functions")
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(1)

    listeners.get(join(project, "functions"))?.("change", join("hello", "index.ts"))
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(2)

    watcher.close()
    expect(listeners.size).toBe(0)
  })

  it("ignores other entries appearing in the project root", () => {
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    mkdirSync(join(project, "src"))
    listeners.get(project)?.("rename", "src")
    listeners.get(project)?.("change", "package.json")
    vi.advanceTimersByTime(500)
    expect(restart).not.toHaveBeenCalled()
  })
})
