import { describe, it, expect, vi, afterEach } from "vitest"
import { hasStrictIssues, printReport, printSection, type DoctorReport } from "../src/commands/doctor.js"

/**
 * How a drift item reads to the operator.
 *
 * Items are keyed `table` + `name`, which for an index or constraint are different things and for a
 * *table* are the same, so the natural `table.name` form printed "widget.widget". Tables only
 * started appearing in this report when the ownership gate got its reporting (E17), and a report an
 * operator distrusts is worse than no report.
 */
const lines = (): string[] => {
  const captured: string[] = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(" "))
  })
  return captured
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("printSection", () => {
  it("prints a table once, not twice", () => {
    const captured = lines()
    printSection("Unmanaged drift", [
      {
        kind: "table",
        table: "widget",
        name: "widget",
        fields: [],
        message: "Unmanaged table widget, push will not drop; manual decision required",
      },
    ])
    const text = captured.join("\n")
    expect(text).toContain("• widget")
    expect(text).not.toContain("widget.widget")
    // The message carries the whole point; a bare object name says nothing about consequence.
    expect(text).toContain("push will not drop; manual decision required")
  })

  it("keeps the qualified form for objects on a table", () => {
    const captured = lines()
    printSection("Unmanaged drift", [
      {
        kind: "index",
        table: "widget",
        name: "widget_name_idx",
        fields: ["name"],
        message: "Unmanaged index widget_name_idx on widget, push will not drop",
      },
    ])
    expect(captured.join("\n")).toContain("• widget.widget_name_idx (name)")
  })

  it("prints nothing at all for an empty section", () => {
    const captured = lines()
    printSection("Unmanaged drift", [])
    expect(captured).toEqual([])
  })

  it("shows what was recorded beside what is live, for a drifted object", () => {
    const captured = lines()
    printSection("Drifted", [
      {
        kind: "rls_attributes",
        table: "posts",
        name: "rls",
        fields: [],
        message: "Row-level security on posts was changed outside Supatype",
        recorded: "enabled=t",
        live: "enabled=f",
      },
    ])
    const text = captured.join("\n")
    expect(text).toContain("recorded: enabled=t")
    expect(text).toContain("live:     enabled=f")
  })
})

/** The ledger's categories, one item each, as an engine with the reconcile reports them. */
const item = (name: string): DoctorReport["missing"][number] => ({
  kind: "index",
  table: "posts",
  name,
  fields: [],
  message: `${name} message`,
})

const empty: DoctorReport = { missing: [], staleManaged: [], unmanagedDrift: [] }

describe("printReport", () => {
  it("prints the reconcile's categories and counts them in the summary", () => {
    const captured = lines()
    printReport({ ...empty, drifted: [item("a")], conflicting: [item("b")], released: [item("c")] })
    const text = captured.join("\n")
    expect(text).toContain("Drifted (changed outside Supatype) (1)")
    expect(text).toContain("Conflicting (a declared name held by someone else) (1)")
    expect(text).toContain("posts.c")
    expect(text).toContain("Summary: 1 drifted, 1 conflicting, 1 released")
  })

  it("reads an older engine's report, which has no ledger categories", () => {
    const captured = lines()
    printReport(empty)
    expect(captured.join("\n")).toContain("No drift detected.")
  })
})

describe("hasStrictIssues", () => {
  it("fails on what a push would change or refuse", () => {
    expect(hasStrictIssues({ ...empty, drifted: [item("a")] })).toBe(true)
    expect(hasStrictIssues({ ...empty, conflicting: [item("a")] })).toBe(true)
    expect(hasStrictIssues({ ...empty, missing: [item("a")] })).toBe(true)
  })

  it("does not fail on someone else's objects or released ones", () => {
    expect(hasStrictIssues({ ...empty, unmanagedDrift: [item("a")], released: [item("b")] })).toBe(false)
  })
})

describe("rebaselined objects", () => {
  it("print in their own section, counted in the summary, and never fail --strict", () => {
    const captured = lines()
    const report = { ...empty, rebaselined: [item("a")] }
    printReport(report)
    const text = captured.join("\n")
    expect(text).toContain("Rebaselined (recorded as they are now) (1)")
    expect(text).toContain("Summary: 1 rebaselined")
    expect(hasStrictIssues(report)).toBe(false)
  })
})

describe("hasStrictIssues() with the engine's own answer", () => {
  it("takes `blocking` when the engine sends it, whatever the lists say", () => {
    expect(hasStrictIssues({ ...empty, drifted: [item("a")], blocking: false })).toBe(false)
    expect(hasStrictIssues({ ...empty, blocking: true })).toBe(true)
  })
})

// C06: a 0.6.0 database reported `claimed=14` to the engine's doctor; the CLI said "No drift detected."
describe("claimed objects (Supatype's own from an earlier engine, not recorded yet)", () => {
  it("print in their own section saying the next push records them, counted in the summary", () => {
    const captured = lines()
    const report = { ...empty, claimed: [item("a"), item("b")], blocking: false } as DoctorReport
    printReport(report)
    const text = captured.join("\n")
    expect(text).toMatch(/Claimed .*will be recorded on the next push.* \(2\)/)
    expect(text).toContain("Summary: 2 claimed")
    expect(text).not.toContain("No drift detected.")
  })

  it("count in --strict as the engine's `blocking` says, and not on an engine that does not say", () => {
    const claimed = { ...empty, claimed: [item("a")] } as DoctorReport
    expect(hasStrictIssues({ ...claimed, blocking: false })).toBe(false)
    expect(hasStrictIssues({ ...claimed, blocking: true })).toBe(true)
    expect(hasStrictIssues(claimed)).toBe(false)
  })
})
