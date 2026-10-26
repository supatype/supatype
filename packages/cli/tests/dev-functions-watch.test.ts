import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchFunctionSources, type WatchFn } from "../src/dev-functions-watch.js"

/**
 * Docker `supatype dev` served the functions it imported when the worker started, and nothing ever
 * told the worker the files had changed: an edit to `functions/<name>/index.ts` kept running the old
 * code until the container was restarted by hand. Native dev and `functions serve` reload, through
 * `deno run --watch`. The worker in a container cannot rely on that, since file events from a
 * Windows or macOS host do not reliably cross a Docker Desktop bind mount, so the CLI, which runs on
 * the host and sees every save, now restarts the worker when a function or hook source changes.
 */

type Listener = (event: string, filename: string | null) => void

let project: string
let listeners: Map<string, Listener>
let closed: string[]

const fakeWatch: WatchFn = (dir, _options, listener) => {
  listeners.set(dir, listener)
  return { close: () => closed.push(dir) }
}

/** A save event in `dir`; `null` is what `fs.watch` reports when it cannot name the file. */
function save(dir: string, filename: string | null): void {
  listeners.get(join(project, dir))?.("change", filename)
}

beforeEach(() => {
  vi.useFakeTimers()
  project = mkdtempSync(join(tmpdir(), "functions-watch-"))
  mkdirSync(join(project, "functions", "issue-ticket"), { recursive: true })
  listeners = new Map()
  closed = []
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(project, { recursive: true, force: true })
})

describe("dev's functions watch", () => {
  it("restarts the worker once after a function source is saved", () => {
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    save("functions", join("issue-ticket", "index.ts"))
    save("functions", join("issue-ticket", "index.ts"))
    expect(restart).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("watches hooks too, since the same worker serves them", () => {
    mkdirSync(join(project, "hooks"))
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    save("hooks", "before-insert.ts")
    vi.advanceTimersByTime(500)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("ignores env files, which the worker reads on every call", () => {
    const restart = vi.fn()
    watchFunctionSources(project, restart, fakeWatch)
    save("functions", ".env.local")
    save("functions", null)
    vi.advanceTimersByTime(500)
    expect(restart).not.toHaveBeenCalled()
  })

  it("watches no directory the project does not have, and closes what it watched", () => {
    const watcher = watchFunctionSources(project, vi.fn(), fakeWatch)
    // The root itself is watched (not recursively) for functions/ or hooks/ appearing later.
    expect([...listeners.keys()].sort()).toEqual([project, join(project, "functions")].sort())
    save("functions", "x.ts")
    watcher.close()
    vi.advanceTimersByTime(500)
    expect([...closed].sort()).toEqual([project, join(project, "functions")].sort())
  })

  it("drops a pending restart when dev shuts down", () => {
    const restart = vi.fn()
    const watcher = watchFunctionSources(project, restart, fakeWatch)
    save("functions", "x.ts")
    watcher.close()
    vi.advanceTimersByTime(500)
    expect(restart).not.toHaveBeenCalled()
  })
})
