import { describe, expect, it } from "vitest"
import { serialRuns } from "../src/serial-runs.js"

/**
 * Native dev pushed on every save without waiting for the push before it. While a push blocked the
 * process that could not overlap; once a push lets the dashboard run, two saves could push at once.
 * A save during a push now asks for one more push after it, as docker dev's queue does.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("serialRuns()", () => {
  it("runs once more after the run in flight, however many triggers came in during it", async () => {
    const log: string[] = []
    const gates = [deferred(), deferred()]
    let running = 0
    const trigger = serialRuns(
      async () => {
        const n = log.filter((l) => l.startsWith("start")).length
        log.push(`start ${n}`)
        running += 1
        expect(running).toBe(1)
        await gates[n]?.promise
        running -= 1
        log.push(`end ${n}`)
      },
      () => undefined,
    )
    const first = trigger()
    void trigger()
    void trigger()
    gates[0]?.resolve()
    gates[1]?.resolve()
    await first
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1"])
  })

  it("reports a run that fails and still runs the one asked for during it", async () => {
    const failures: string[] = []
    let runs = 0
    const gate = deferred()
    const trigger = serialRuns(
      async () => {
        runs += 1
        if (runs === 1) {
          await gate.promise
          throw new Error("push refused")
        }
      },
      (err) => failures.push(err instanceof Error ? err.message : String(err)),
    )
    const first = trigger()
    void trigger()
    gate.resolve()
    await first
    expect(failures).toEqual(["push refused"])
    expect(runs).toBe(2)
  })
})
