import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * After `up -d`, `dev` waits for Postgres again, because `up -d` recreates `db` when its definition
 * changed since it was started for the schema push. A wait that runs out has to fail the way every
 * other failed start does. It threw a bare Error instead: the dev session was left held, the db
 * container's logs were not kept, and the message was a stack trace's.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  error: (line: string) => lines.push(`error: ${line}`),
  plain: (line?: string) => lines.push(line ?? ""),
}))

const { waitForDatabaseAfterUp } = await import("../src/dev-db-ready.js")

const TIMEOUT = "Compose db service did not become healthy in time"

function steps(wait: () => Promise<void>) {
  const order: string[] = []
  return {
    order,
    waitHealthy: vi.fn(wait),
    dumpLogs: vi.fn(() => {
      order.push("dumpLogs")
    }),
    onFailure: vi.fn(() => {
      order.push("onFailure")
    }),
  }
}

beforeEach(() => {
  lines.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("waiting for Postgres after the stack comes up", () => {
  it("carries on when Postgres answers", async () => {
    const s = steps(async () => {})

    await waitForDatabaseAfterUp(s)

    expect(s.waitHealthy).toHaveBeenCalledTimes(1)
    expect(s.onFailure).not.toHaveBeenCalled()
    expect(s.dumpLogs).not.toHaveBeenCalled()
  })

  it("on a timeout ends the session, keeps the db logs, and exits non-zero saying why", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      s.order.push("exit")
      throw new Error(`exit ${String(code)}`)
    })
    const s = steps(async () => {
      throw new Error(TIMEOUT)
    })

    await expect(waitForDatabaseAfterUp(s)).rejects.toThrow("exit 1")

    expect(exit).toHaveBeenCalledWith(1)
    expect(s.order).toEqual(["onFailure", "dumpLogs", "exit"])
    const out = lines.join("\n")
    expect(out).toContain("Postgres did not answer again after the rest of the stack came up")
    expect(out).toContain(TIMEOUT)
  })
})
