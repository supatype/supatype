/**
 * The seed history screen, in each of the states it can be in.
 *
 * Typecheck says the view is well typed; it does not say it renders. Every state below is
 * one a reader will actually meet, and the empty one is first because it is the state a new
 * project is in and so the one most likely to be written and never looked at.
 *
 * The drift check is the part worth testing hardest. "This seed is not what ran" is the
 * question the screen exists to answer, and it cannot be answered from a single row.
 */

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  markRuns,
  mapSeedRow,
  rowsWrittenSummary,
  SeedHistoryView,
  SEEDS_LIST_SQL,
  type SeedRun,
} from "../src/views/SeedHistory.js"

function run(overrides: Partial<SeedRun> & { id: number; file: string }): SeedRun {
  return {
    ir_hash: "sha256:aaaaaaaa",
    schema_fingerprint: "sha256:schema",
    applied_at: "2026-09-29 11:00:00+00",
    duration_ms: 12,
    status: "committed",
    rows_written: { Organiser: 2 },
    error_message: null,
    engine_version: "0.3.3",
    ...overrides,
  }
}

function render(props: Partial<React.ComponentProps<typeof SeedHistoryView>>): string {
  return renderToStaticMarkup(
    <SeedHistoryView
      runs={null}
      loading={false}
      error={null}
      onRefresh={() => {}}
      {...props}
    />,
  )
}

describe("before anything has been seeded", () => {
  it("says so, and says what to do about it", () => {
    const html = render({ runs: [] })
    expect(html).toContain("No seeds have run here")
    expect(html).toContain("supatype seed")
    expect(html).toContain("Refresh")
  })

  /**
   * The ledger table is created alongside `_supatype.migrations`, so its absence means this
   * database predates seeding. That is the same empty state, not an error to alarm anyone.
   */
  it("treats a missing ledger table as empty rather than broken", () => {
    const html = render({ error: 'relation "_supatype.seeds" does not exist' })
    expect(html).toContain("No seeds have run here")
    expect(html).not.toContain("does not exist")
  })
})

describe("when the query fails", () => {
  it("shows what went wrong and offers to try again", () => {
    const html = render({ error: "connection refused" })
    expect(html).toContain("connection refused")
    expect(html).not.toContain("No seeds have run here")
  })
})

describe("while it is reading", () => {
  it("says it is reading rather than showing an empty table", () => {
    const html = render({ loading: true })
    expect(html).toContain("Loading seed runs")
    // An empty table before the first read looks exactly like a project that has never
    // seeded, which is the one thing this screen must not get wrong.
    expect(html).not.toContain("No seeds have run here")
    expect(html).not.toContain("<table")
  })
})

describe("the listing", () => {
  it("shows a run, what it wrote, and how long it took", () => {
    const html = render({
      runs: markRuns([run({ id: 1, file: "seed.ts", rows_written: { Organiser: 2, Event: 5 } })]),
    })
    expect(html).toContain("seed.ts")
    expect(html).toContain("committed")
    expect(html).toContain("Organiser 2, Event 5")
    expect(html).toContain("12ms")
    expect(html).toContain("0.3.3")
  })

  /**
   * A run that wrote nothing should not look like one that wrote everything. An empty cell
   * reads as "no data here" rather than "this run did nothing".
   */
  it("says a run wrote nothing rather than leaving the cell blank", () => {
    const html = render({ runs: markRuns([run({ id: 1, file: "seed.ts", rows_written: {} })]) })
    expect(html).toContain("nothing")
  })

  /**
   * A seed that failed is the thing an author most wants to see. Hiding it would make this
   * screen agree with a database that disagrees with it.
   */
  it("shows a rolled-back run, with what went wrong", () => {
    const html = render({
      runs: markRuns([
        run({
          id: 1,
          file: "seed.ts",
          status: "rolled_back",
          rows_written: {},
          error_message: "Organiser.slug is already taken",
        }),
      ]),
    })
    expect(html).toContain("rolled back")
    expect(html).toContain("Organiser.slug is already taken")
  })
})

describe("drift", () => {
  it("badges a file whose latest run used a different document", () => {
    const html = render({
      runs: markRuns([
        run({ id: 2, file: "seed.ts", ir_hash: "sha256:bbbbbbbb" }),
        run({ id: 1, file: "seed.ts", ir_hash: "sha256:aaaaaaaa" }),
      ]),
    })
    expect(html).toContain("changed since it ran")
  })

  it("does not badge a file that ran twice unchanged", () => {
    const html = render({
      runs: markRuns([
        run({ id: 2, file: "seed.ts", ir_hash: "sha256:aaaaaaaa" }),
        run({ id: 1, file: "seed.ts", ir_hash: "sha256:aaaaaaaa" }),
      ]),
    })
    expect(html).not.toContain("changed since it ran")
  })

  /** One run cannot have drifted: there is nothing for it to have drifted from. */
  it("does not badge the first run of a file", () => {
    const html = render({ runs: markRuns([run({ id: 1, file: "seed.ts" })]) })
    expect(html).not.toContain("changed since it ran")
  })

  /** The badge belongs on the row a reader is looking at when they ask, which is the latest. */
  it("marks only the latest run of a file", () => {
    const marked = markRuns([
      run({ id: 3, file: "seed.ts", ir_hash: "sha256:cccccccc" }),
      run({ id: 2, file: "seed.ts", ir_hash: "sha256:aaaaaaaa" }),
      run({ id: 1, file: "backfill.ts" }),
    ])
    expect(marked.map((r) => [r.id, r.latest, r.drifted])).toEqual([
      [3, true, true],
      [2, false, false],
      [1, true, false],
    ])
  })

  /**
   * Drift is against the run *before* this one, not against the oldest run of the file.
   *
   * With only two runs in a fixture those are the same row, so this case exists to tell them
   * apart: a file that changed once and has since run twice unchanged has not drifted, and a
   * check that looked at the oldest run would say it had, forever.
   */
  it("compares against the run before it, not the first one ever", () => {
    const marked = markRuns([
      run({ id: 3, file: "seed.ts", ir_hash: "sha256:cccccccc" }),
      run({ id: 2, file: "seed.ts", ir_hash: "sha256:cccccccc" }),
      run({ id: 1, file: "seed.ts", ir_hash: "sha256:aaaaaaaa" }),
    ])
    expect(marked[0]?.drifted).toBe(false)
  })

  /** And it still notices when the most recent two genuinely differ. */
  it("notices a change against the run before it, with older runs behind them", () => {
    const marked = markRuns([
      run({ id: 3, file: "seed.ts", ir_hash: "sha256:cccccccc" }),
      run({ id: 2, file: "seed.ts", ir_hash: "sha256:bbbbbbbb" }),
      run({ id: 1, file: "seed.ts", ir_hash: "sha256:cccccccc" }),
    ])
    expect(marked[0]?.drifted).toBe(true)
  })

  /** Two files drift independently of each other. */
  it("keeps one file's history out of another's", () => {
    const marked = markRuns([
      run({ id: 4, file: "b.ts", ir_hash: "sha256:22222222" }),
      run({ id: 3, file: "a.ts", ir_hash: "sha256:11111111" }),
      run({ id: 2, file: "b.ts", ir_hash: "sha256:22222222" }),
      run({ id: 1, file: "a.ts", ir_hash: "sha256:11111111" }),
    ])
    expect(marked.filter((r) => r.drifted)).toEqual([])
  })
})

describe("reading the ledger row", () => {
  it("decodes what the proxy hands back", () => {
    const decoded = mapSeedRow({
      id: "7",
      file: "seed.ts",
      ir_hash: "sha256:abc",
      schema_fingerprint: "sha256:def",
      applied_at: "2026-09-29 11:00:00+00",
      duration_ms: "34",
      status: "rolled_back",
      rows_written: { Organiser: 2 },
      error_message: "boom",
      engine_version: "0.3.3",
    })
    expect(decoded.id).toBe(7)
    expect(decoded.duration_ms).toBe(34)
    expect(decoded.status).toBe("rolled_back")
    expect(decoded.rows_written).toEqual({ Organiser: 2 })
  })

  /**
   * A proxy may hand JSONB back decoded or as text. Reading only one of those is the
   * difference between a screen that says a run wrote nothing and a run that wrote plenty.
   */
  it("reads rows written whether it arrives as an object or as text", () => {
    expect(mapSeedRow({ rows_written: '{"Organiser":2}' }).rows_written).toEqual({
      Organiser: 2,
    })
    expect(mapSeedRow({ rows_written: { Organiser: 2 } }).rows_written).toEqual({
      Organiser: 2,
    })
  })

  it("survives a row that is not what it expected", () => {
    expect(mapSeedRow({}).file).toBe("")
    expect(mapSeedRow({ rows_written: "not json" }).rows_written).toEqual({})
    expect(mapSeedRow({ rows_written: null }).rows_written).toEqual({})
    expect(mapSeedRow({ status: "something else" }).status).toBe("committed")
  })

  it("summarises what was written, and says nothing when nothing was", () => {
    expect(rowsWrittenSummary({ Organiser: 2, Event: 5 })).toBe("Organiser 2, Event 5")
    expect(rowsWrittenSummary({})).toBe("")
  })
})

describe("how it reads the ledger", () => {
  /** A table, through the proxy, exactly as the migrations screen reads its own. */
  it("asks for the newest runs first, with no new engine endpoint", () => {
    expect(SEEDS_LIST_SQL).toContain("_supatype.seeds")
    expect(SEEDS_LIST_SQL).toContain("ORDER BY applied_at DESC")
    // Cast, because the column is TIMESTAMPTZ and the proxy would otherwise hand back
    // whatever its driver decided a timestamp is.
    expect(SEEDS_LIST_SQL).toContain("applied_at::TEXT")
  })
})
