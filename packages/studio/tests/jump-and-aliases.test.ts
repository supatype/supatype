import { describe, expect, it } from "vitest"
import { jumpTargetsFor } from "../src/components/JumpToSearch.js"
import { ROUTE_ALIASES } from "../src/lib/route-aliases.js"

/**
 * S-3: `/scheduled-jobs` and `/intelligence`, the names the sidebar's own labels give, answered
 * "Page not found" where `/jobs` and `/ai/usage` open a page.
 * S-22: Jump-to found no Auth Hooks, Attack Protection, Backups, Usage or Audit page.
 */
describe("route aliases", () => {
  it("send the sidebar's labels to their pages", () => {
    expect(ROUTE_ALIASES["scheduled-jobs"]).toBe("/jobs")
    expect(ROUTE_ALIASES["intelligence"]).toBe("/ai/usage")
  })
})

describe("jump to", () => {
  const labels = jumpTargetsFor({ role: "admin", permissions: { sqlEditor: true } }).map((target) => target.label)

  it.each(["Auth Hooks", "Attack Protection", "Backups", "AI Usage", "Audit Log"])("finds %s", (label) => {
    expect(labels).toContain(label)
  })
})
