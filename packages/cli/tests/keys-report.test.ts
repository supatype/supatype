import { describe, expect, it } from "vitest"
import { keysWriteReport } from "../src/commands/keys.js"

/**
 * S-15: with every key already in `.env`, `supatype keys` printed "written to .env:" and nothing
 * after it. A header over an empty list reads as output that was cut off.
 */
describe("the report of a keys write", () => {
  it("lists what was written", () => {
    const lines = keysWriteReport(10, { path: ".env", written: ["ANON_KEY"], kept: [] })
    expect(lines.join("\n")).toContain("written to .env:\n\n  ANON_KEY")
  })

  it("says nothing was written, and why, when every key was already there", () => {
    const text = keysWriteReport(10, { path: ".env", written: [], kept: ["ANON_KEY", "SERVICE_ROLE_KEY"] }).join("\n")
    expect(text).not.toMatch(/written to \.env:\s*\n*\s*(Left|$)/)
    expect(text).toContain("No keys were written to .env")
    expect(text).toContain("ANON_KEY")
    expect(text).toContain("--force")
  })
})
