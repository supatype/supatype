import { afterEach, describe, expect, it } from "vitest"

/**
 * Fresh-user test C5: dev's terminal was closed and the stack kept running. Closing a terminal
 * sends SIGHUP (on Windows, when the console window closes; elsewhere, when the terminal hangs up),
 * and dev did not listen for it, so it was killed with no shutdown at all. It now shuts down on
 * SIGHUP the way it does on Ctrl+C.
 */

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]
const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]))
const exitBefore = process.listeners("exit")

afterEach(() => {
  for (const signal of SIGNALS) {
    const added = process.listeners(signal).filter((l) => !before.get(signal)?.includes(l))
    for (const listener of added) process.removeListener(signal, listener)
  }
  for (const listener of process.listeners("exit").filter((l) => !exitBefore.includes(l))) {
    process.removeListener("exit", listener)
  }
})

describe("dev shutdown hooks", () => {
  it("shut dev down when its terminal hangs up (SIGHUP)", async () => {
    const { ensureDevShutdownHooks } = await import("../src/dev-shutdown.js")
    const count = process.listenerCount("SIGHUP")
    ensureDevShutdownHooks()
    expect(process.listenerCount("SIGHUP")).toBe(count + 1)
  })
})
