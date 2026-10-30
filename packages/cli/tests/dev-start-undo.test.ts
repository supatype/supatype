import { afterEach, describe, expect, it } from "vitest"
import { drainStartUndo, pushStartUndo, pushStartUndoLast, resetDevShutdownForTests } from "../src/dev-shutdown.js"

/**
 * Nic's decision on round 3b: what dev's start began is undone with every service stopped at once,
 * and native Postgres, which they all use, stopped after them.
 */
afterEach(() => resetDevShutdownForTests())

/** An undo that takes `ms`, recording when it started and ended in `log`. */
function slowUndo(name: string, ms: number, log: string[]): () => Promise<void> {
  return async () => {
    log.push(`${name} start`)
    await new Promise((done) => setTimeout(done, ms))
    log.push(`${name} end`)
  }
}

describe("undoing dev's start", () => {
  it("stops the services together, then Postgres", async () => {
    const log: string[] = []
    pushStartUndoLast(slowUndo("postgres", 10, log))
    pushStartUndo(slowUndo("realtime", 50, log))
    pushStartUndo(slowUndo("storage", 50, log))
    pushStartUndo(slowUndo("server", 50, log))
    expect(await drainStartUndo()).toEqual([])
    expect(log.slice(0, 3).sort()).toEqual(["realtime start", "server start", "storage start"])
    expect(log.slice(-2)).toEqual(["postgres start", "postgres end"])
  })

  it("still stops Postgres when a service's undo fails, and says which failed", async () => {
    const log: string[] = []
    pushStartUndoLast(slowUndo("postgres", 1, log))
    pushStartUndo(() => {
      throw new Error("realtime would not stop")
    })
    const errors = await drainStartUndo()
    expect(errors.map((err) => (err instanceof Error ? err.message : String(err)))).toEqual(["realtime would not stop"])
    expect(log).toEqual(["postgres start", "postgres end"])
  })
})
