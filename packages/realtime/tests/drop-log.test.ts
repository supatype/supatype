import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { formatDrop, logDrop, type DroppedChange } from "../src/drop-log.js"
import { parseLogLevel } from "../src/env.js"
import { captureConsole, type ConsoleCall } from "./fixtures/console.js"

const drop: DroppedChange = {
  schema: "public",
  table: "posts",
  event: "UPDATE",
  role: "authenticated",
  reason: "row not visible to subscriber",
}

describe("logDrop", () => {
  let captured: { calls: ConsoleCall[]; restore: () => void }
  const calls = (): ConsoleCall[] => captured.calls

  beforeEach(() => {
    captured = captureConsole()
  })

  afterEach(() => captured.restore())

  // A policy denial is the rules working: one line per withheld event per subscriber is noise at
  // the default level, and on a busy table it buries the failures worth reading.
  it("keeps a policy denial quiet at info", () => {
    logDrop(drop, "denied", "info")
    expect(calls()).toEqual([])
  })

  it("logs a policy denial at debug", () => {
    logDrop(drop, "denied", "debug")
    expect(calls()).toEqual([{ method: "debug", args: [formatDrop(drop)] }])
  })

  // A failure is realtime unable to decide, which fails closed: always worth an operator's attention.
  it.each(["info", "debug"] as const)("always logs a failure at warn (level %s)", (level) => {
    const failure = { ...drop, reason: "table catalog could not be read (SQLSTATE 42501)" }
    logDrop(failure, "failed", level)
    expect(calls()).toEqual([{ method: "warn", args: [formatDrop(failure)] }])
  })
})

describe("parseLogLevel", () => {
  it("defaults to info", () => {
    expect(parseLogLevel(undefined)).toBe("info")
    expect(parseLogLevel("")).toBe("info")
  })

  it("reads debug and info, in any case", () => {
    expect(parseLogLevel("debug")).toBe("debug")
    expect(parseLogLevel("DEBUG")).toBe("debug")
    expect(parseLogLevel(" Info ")).toBe("info")
  })

  // A typo would otherwise leave an operator waiting for lines that never come.
  it("refuses anything else", () => {
    expect(() => parseLogLevel("verbose")).toThrow(/REALTIME_LOG_LEVEL/)
  })
})
