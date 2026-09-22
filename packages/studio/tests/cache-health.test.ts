import { describe, expect, it } from "vitest"
import {
  arenaFillPct,
  describeStaleness,
  formatPct,
  hitRateOver,
  rowCacheHeadline,
  type RowCacheStatus,
} from "../src/lib/cache-health.js"

/**
 * §12.2 lists four rules the supacache views impose on a UI, each of which is a bug if ignored
 * and three of which look like working code. They are all here because they are all arithmetic or
 * a branch, and neither survives being remembered.
 */

function status(over: Partial<RowCacheStatus> = {}): RowCacheStatus {
  return {
    state: "participating",
    decode_enabled: true,
    database: "proj",
    stale_after_ms: 200,
    coherent: true,
    slot_lost: false,
    beat_age_ms: 40,
    registrations: 3,
    registrations_loaded: 3,
    entries: 120,
    hits_total: 900,
    misses_total: 100,
    arena_used_bytes: 4096,
    arena_capacity_bytes: 1024 * 1024,
    hit_pct: 90,
    participating_databases: 1,
    incoherent_databases: 0,
    ...over,
  }
}

// ─── Rule 1: the counters are cumulative and are not reset by reading ─────────

describe("a hit rate from cumulative counters", () => {
  it("is computed from the window, not from the totals", () => {
    // The failure this prevents: a cache that served 9,000 hits and 1,000 misses in its good
    // first hour and has missed every read since still reports 90% from the totals. From the
    // delta it reports 0%, which is the truth and the thing worth alerting on.
    const prev = { hits: 9_000, misses: 1_000, at: 0 }
    const next = { hits: 9_000, misses: 1_400, at: 10_000 }
    expect(hitRateOver(prev, next)).toEqual({ pct: 0, hits: 0, misses: 400, windowMs: 10_000 })
  })

  it("has no answer from one sample, and says so rather than guessing", () => {
    expect(hitRateOver(null, { hits: 900, misses: 100, at: 1_000 }).pct).toBeNull()
  })

  it("has no answer for a window with no reads in it", () => {
    // Rule 4's shape again: an idle minute is not a 0% hit rate.
    const s = { hits: 900, misses: 100, at: 0 }
    expect(hitRateOver(s, { ...s, at: 10_000 }).pct).toBeNull()
  })

  it("does not report a rate across a restart", () => {
    // The segment starts again from zero, so the delta goes negative. That is a new counter, not
    // a bad read, and there is no rate spanning the boundary — 0% there would be an invented
    // outage at exactly the moment someone is looking.
    const prev = { hits: 9_000, misses: 1_000, at: 0 }
    expect(hitRateOver(prev, { hits: 12, misses: 3, at: 10_000 }).pct).toBeNull()
  })

  it("rounds to one decimal rather than showing a float", () => {
    expect(hitRateOver({ hits: 0, misses: 0, at: 0 }, { hits: 2, misses: 1, at: 1_000 }).pct).toBe(66.7)
  })
})

// ─── Rule 2: a switched-off feature returns no rows, not zeroes ───────────────

describe("the five states of the row cache", () => {
  it("keeps off and waiting-for-tables apart", () => {
    // Both have nothing cached and nothing wrong, and they are opposite answers to "should I do
    // something". Collapsing them reports a disabled feature as a healthy idle one.
    const off = rowCacheHeadline(status({ state: "off", decode_enabled: false }))
    const idle = rowCacheHeadline(status({ state: "idle", registrations: 0 }))
    expect(off.label).toBe("Off")
    expect(idle.label).not.toBe("Off")
    expect(off.detail).not.toBe(idle.detail)
    expect(off.tone).toBe("neutral")
    expect(idle.tone).toBe("neutral")
  })

  it("distinguishes a lost slot from merely being behind", () => {
    // Different causes and different remedies: a lost slot means invalidations were dropped and
    // will not arrive, being behind means they are late.
    const lost = rowCacheHeadline(status({ state: "incoherent", slot_lost: true, coherent: false }))
    const behind = rowCacheHeadline(status({ state: "incoherent", coherent: false }))
    expect(lost.label).toBe("Slot lost")
    expect(behind.label).toBe("Behind")
    expect(lost.tone).toBe("bad")
    expect(behind.tone).toBe("bad")
  })

  it("says incoherence costs speed, not correctness", () => {
    // The cache fails closed. Whoever reads this panel at 3am should not be looking for bad data.
    for (const s of [status({ state: "incoherent", coherent: false }), status({ state: "incoherent", slot_lost: true })]) {
      expect(rowCacheHeadline(s).detail).toMatch(/still correct/)
    }
  })

  it("treats a missing answer as unavailable rather than off", () => {
    // No response at all is not the same claim as "the feature is off", and the remedies differ:
    // one is a pg_monitor grant, the other is a setting.
    expect(rowCacheHeadline(null).label).toBe("Unavailable")
    expect(rowCacheHeadline(null).detail).toMatch(/pg_monitor/)
    expect(rowCacheHeadline(status({ state: "unavailable" })).label).toBe("Unavailable")
  })

  it("counts the tables it is serving, in the singular when there is one", () => {
    expect(rowCacheHeadline(status({ registrations: 1 })).detail).toContain("1 registered table ")
    expect(rowCacheHeadline(status({ registrations: 4 })).detail).toContain("4 registered tables")
  })
})

// ─── Rule 3: stale_after_ms is a promise, not an ops metric ───────────────────

describe("the staleness window, in words", () => {
  it("says what a user will observe, not what the column is called", () => {
    const s = describeStaleness(200)
    expect(s).toContain("200 ms")
    expect(s).toMatch(/behind writes made on other connections/)
    // The half of the guarantee that stops this reading as "your data may be wrong".
    expect(s).toMatch(/Your own writes are never stale to you/)
  })

  it("scales to seconds, because the window grows with participating databases", () => {
    // Past the invalidation pool size a database waits its turn and is behind by the cycle time
    // by design. A panel that always printed the 200ms default would understate the promise.
    expect(describeStaleness(1_400)).toContain("1.4 seconds")
    expect(describeStaleness(3_000)).toContain("3 seconds")
  })
})

// ─── Rule 4: hit_pct is NULL, not 0, before the first lookup ──────────────────

describe("a percentage nobody has measured yet", () => {
  it("renders as a dash, never as zero", () => {
    // A fresh cache showing 0% looks broken and is not.
    expect(formatPct(null)).toBe("—")
    expect(formatPct(0)).toBe("0%")
    expect(formatPct(93.4)).toBe("93.4%")
  })

  it("applies to the arena too, where there may be no arena", () => {
    expect(arenaFillPct(0, 0)).toBeNull()
    expect(arenaFillPct(0, 1024)).toBe(0)
    expect(arenaFillPct(512, 1024)).toBe(50)
  })
})
