import { afterEach, describe, expect, it, vi } from "vitest"
import { STOP_SIGNALS } from "../src/stop-signals.js"

/**
 * Review of round 7: a Ctrl+C on a dev dashboard prompt starts the shutdown, which ends the dev
 * session and so cancels the prompt still waiting. `confirm` took that cancel as the person's and
 * called `p.cancel`, which exits 0 at once: the shutdown never finished, and Postgres was cut off
 * mid stop (N32 again, by the dashboard's path). A prompt the shutdown cancelled waits for it.
 */
vi.mock("../src/ui/interactive.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isInteractive: () => true,
}))
vi.mock("../src/dev-session.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveDevSession: () => ({ isTui: () => true, isInkMounted: () => true }),
}))

const { confirm } = await import("../src/ui/confirm.js")
const { ensureDevShutdownHooks, pushStartUndoLast, requestDevShutdown, resetDevShutdownForTests } = await import("../src/dev-shutdown.js")

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let before = new Map<NodeJS.Signals, readonly unknown[]>()

afterEach(() => {
  vi.restoreAllMocks()
  resetDevShutdownForTests()
  for (const signal of STOP_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!(before.get(signal) ?? []).includes(listener)) process.removeListener(signal, listener)
    }
  }
})

describe("a dashboard prompt cancelled by dev's shutdown", () => {
  it("does not end the process; the shutdown does, once what the start began has stopped", async () => {
    before = new Map(STOP_SIGNALS.map((signal) => [signal, [...process.listeners(signal)]] as const))
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const codes: number[] = []
    const first = new Promise<number>((resolve) => {
      function recordExit(code?: string | number | null): never
      function recordExit(code?: string | number | null): void {
        codes.push(Number(code ?? 0))
        resolve(Number(code ?? 0))
      }
      vi.spyOn(process, "exit").mockImplementation(recordExit)
    })
    ensureDevShutdownHooks()
    let postgresStopped = false
    pushStartUndoLast(async () => {
      await tick(100)
      postgresStopped = true
    })

    void confirm("Save port 54339 to .env?")
    await tick(20)
    requestDevShutdown()

    expect(await first).toBe(130)
    expect(postgresStopped).toBe(true)
    expect(codes).toEqual([130])
  })
})
