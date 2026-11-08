import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WatchFn } from "../src/dev-functions-watch.js"
import { watchDevSchema } from "../src/dev-schema-watch.js"

/**
 * `supatype dev` read the schema for its first push, spent minutes bringing the stack up, and only
 * then started watching. A save in between was never pushed: the database kept the start-up schema,
 * and putting the file back later printed "pushing schema..." over a push with nothing to do, which
 * looked like dev had hung. The watch now catches up on a change made before it started.
 */

type Listener = (event: string, filename: string | null) => void

let listener: Listener | null
let closed: number

const fakeWatch: WatchFn = (_dir, _options, onEvent) => {
  listener = onEvent
  return { close: () => (closed += 1) }
}

function save(filename: string | null): void {
  listener?.("change", filename)
}

beforeEach(() => {
  vi.useFakeTimers()
  listener = null
  closed = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe("dev's schema watch", () => {
  it("pushes once after a burst of saves to a schema file", async () => {
    const push = vi.fn()
    watchDevSchema({ dir: "schema", changedSinceLastPush: () => false, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(0)
    save("index.ts")
    save("index.ts")
    expect(push).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("Change detected in index.ts")
  })

  // Issue 66: `sed -i` and some editors save by writing another file and renaming it over the
  // schema, and the event can name only the other file. Those saves were ignored, so the database
  // kept the old schema and nothing said so. Any event now leads to a check of the schema itself.
  it("pushes a save made by renaming another file over the schema, when the schema changed", async () => {
    const push = vi.fn()
    let changed = false
    watchDevSchema({ dir: "schema", changedSinceLastPush: () => changed, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(0)
    changed = true
    save("sedgRSlMR")
    save(null)
    await vi.advanceTimersByTimeAsync(500)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith("Change detected in the schema")
  })

  it("does not push for another file's event when the schema did not change", async () => {
    const push = vi.fn()
    watchDevSchema({ dir: "schema", changedSinceLastPush: () => false, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(0)
    save(".index.ts.swp")
    await vi.advanceTimersByTimeAsync(500)
    expect(push).not.toHaveBeenCalled()
  })

  it("pushes a change saved while the stack was starting, before any event arrives", async () => {
    const push = vi.fn()
    watchDevSchema({ dir: "schema", changedSinceLastPush: () => true, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(0)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0]?.[0]).toMatch(/changed while dev was starting/)
  })

  it("does not push at start when the schema is the one the first push read", async () => {
    const push = vi.fn()
    watchDevSchema({ dir: "schema", changedSinceLastPush: async () => false, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(500)
    expect(push).not.toHaveBeenCalled()
  })

  it("pushes at start when the schema cannot be read, so the push reports why", async () => {
    const push = vi.fn()
    const unreadable = () => {
      throw new Error("Schema file not found")
    }
    watchDevSchema({ dir: "schema", changedSinceLastPush: unreadable, push }, fakeWatch)
    await vi.advanceTimersByTimeAsync(0)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("stops a pending push and the watcher when closed", async () => {
    const push = vi.fn()
    const watch = watchDevSchema({ dir: "schema", changedSinceLastPush: () => false, push }, fakeWatch)
    save("index.ts")
    watch.close()
    await vi.advanceTimersByTimeAsync(500)
    expect(push).not.toHaveBeenCalled()
    expect(closed).toBe(1)
  })
})
