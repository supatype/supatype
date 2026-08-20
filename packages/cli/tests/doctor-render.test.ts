import { describe, it, expect, vi, afterEach } from "vitest"
import { printSection } from "../src/commands/doctor.js"

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
})
