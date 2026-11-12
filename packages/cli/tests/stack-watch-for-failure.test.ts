import { describe, expect, it } from "vitest"
import { watchForFailure, type ExitedService, type StackWatch } from "../src/stack-exit-watch.js"

/**
 * 0.9.2 release test round 2 (N-FF11): a storage container that refuses its settings starts, exits
 * a second later and is restarted by its policy, so a look straight after compose returns sees it
 * running. `self-host compose restart` watches it for a while instead.
 */

/** A watch whose service is healthy for the first `healthyLooks` looks, then failing. */
function watchFailingAfter(healthyLooks: number): StackWatch & { looks: number } {
  const failed: ExitedService = { service: "storage", exitCode: 1, restarting: true }
  const watch = {
    looks: 0,
    exited: async () => undefined,
    failing: async () => (++watch.looks > healthyLooks ? failed : undefined),
    logTail: async () => "",
  }
  return watch
}

const STORAGE = new Set(["storage"])

describe("watchForFailure", () => {
  it("finds a service that fails after it first looked healthy", async () => {
    const watch = watchFailingAfter(2)
    expect(await watchForFailure(watch, STORAGE, 1000, 10)).toMatchObject({ service: "storage", restarting: true })
    expect(watch.looks).toBe(3)
  })

  it("looks once with no window, and reports nothing for a healthy stack", async () => {
    const watch = watchFailingAfter(Number.POSITIVE_INFINITY)
    expect(await watchForFailure(watch, STORAGE, 0, 10)).toBeUndefined()
    expect(watch.looks).toBe(1)
  })
})
