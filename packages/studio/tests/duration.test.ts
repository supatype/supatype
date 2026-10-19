import { describe, expect, it } from "vitest"
import { durationMsOf, formatDuration, formatDurationValue, parseDuration } from "../src/lib/duration.js"

/**
 * A `Duration` is stored as `{ ms }` and edited as text. Kitchen-sink's talk Length showed
 * `[object Object]` because Studio had no widget for it; these pin the parser and the formatter the
 * widget and the list cell share.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function msOf(text: string): number | null {
  const parsed = parseDuration(text)
  return parsed.ok ? parsed.ms : null
}

function messageOf(text: string): string | null {
  const parsed = parseDuration(text)
  return parsed.ok ? null : parsed.message
}

describe("parseDuration reads", () => {
  it.each([
    ["1h 30m", 90 * MIN],
    ["90m", 90 * MIN],
    ["1:30:00", 90 * MIN],
    ["45s", 45_000],
    ["2h", 2 * HOUR],
    ["1h30m", 90 * MIN],
    ["1h, 30m", 90 * MIN],
    ["  1H 30M  ", 90 * MIN],
    ["1 hour 30 minutes", 90 * MIN],
    ["2 hours", 2 * HOUR],
    ["1 hr 5 mins", 65 * MIN],
    ["1.5h", 90 * MIN],
    ["0.5s", 500],
    ["250ms", 250],
    ["1m 30s 250ms", 90_250],
    ["1d", DAY],
    ["2 days 3h", 2 * DAY + 3 * HOUR],
    ["0s", 0],
    ["0:45", 45 * MIN],
    ["1:30", 90 * MIN],
    ["0:00:45", 45_000],
    ["1:02:03.5", HOUR + 2 * MIN + 3_500],
    ["1:02:03.25", HOUR + 2 * MIN + 3_250],
    ["30:00:00", 30 * HOUR],
    ["3 seconds", 3_000],
  ])("%j as %d ms", (text, ms) => {
    expect(msOf(text)).toBe(ms)
  })

  it("rounds a fraction finer than a millisecond to the nearest one", () => {
    expect(msOf("1.0006s")).toBe(1001)
  })
})

describe("parseDuration refuses", () => {
  it.each([
    ["abc", /Could not read "abc"/],
    ["1h abc", /Could not read/],
    ["90", /Add a unit/],
    ["1.5", /Add a unit/],
    ["5x", /unit/],
    ["5 fortnights", /unit/],
    ["1h 1h", /more than once/],
    ["30m 1m", /more than once/],
    ["-5m", /negative/],
    ["1:60", /under 60/],
    ["1:30:75", /under 60/],
    ["1:2", /Could not read/],
    ["1:30:00:00", /Could not read/],
    [":30", /Could not read/],
    ["h", /Could not read/],
    ["1e3s", /unit/],
    ["9999999999999d", /too long/],
  ])("%j", (text, message) => {
    expect(messageOf(text)).toMatch(message)
  })

  it("says nothing is there for blank text, so a caller can treat it as no value", () => {
    expect(parseDuration("   ")).toEqual({ ok: true, ms: null })
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [90 * MIN, "1h 30m"],
    [2 * HOUR, "2h"],
    [HOUR + 1_000, "1h 1s"],
    [90_250, "1m 30s 250ms"],
    [250, "250ms"],
    [DAY, "1d"],
    [DAY + 2 * HOUR + 3 * MIN + 4_000 + 5, "1d 2h 3m 4s 5ms"],
    [30 * HOUR, "1d 6h"],
  ])("%d ms as %j", (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })

  it("reads back to the same number of milliseconds", () => {
    for (const ms of [0, 1, 999, 1_000, 59_999, 61_001, 3_599_999, HOUR, DAY - 1, 3 * DAY + 7, 123_456_789]) {
      expect(msOf(formatDuration(ms))).toBe(ms)
    }
  })
})

describe("durationMsOf and formatDurationValue", () => {
  it("reads the stored shape", () => {
    expect(durationMsOf({ ms: 2_700_000 })).toBe(2_700_000)
    expect(formatDurationValue({ ms: 2_700_000 })).toBe("45m")
  })

  it.each([[null], [undefined], ["45m"], [{ ms: "45" }], [{ ms: -1 }], [{ ms: Number.NaN }], [{ seconds: 3 }], [[1]], [45]])(
    "has no duration in %j",
    (value) => {
      expect(durationMsOf(value)).toBeNull()
      expect(formatDurationValue(value)).toBeNull()
    },
  )
})
