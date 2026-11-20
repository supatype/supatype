import { describe, expect, it } from "vitest"
import { jumpTargetsFor } from "../src/components/JumpToSearch.js"

const OWNER = { role: "owner", permissions: {} }

describe("jump-to search", () => {
  it("offers no page that only says the feature is coming soon", () => {
    const hrefs = jumpTargetsFor(OWNER).map((t) => t.href)
    for (const href of ["/webhooks", "/jobs", "/observability/logs/api"]) expect(hrefs).not.toContain(href)
  })

  it("still offers the pages that work", () => {
    const hrefs = jumpTargetsFor(OWNER).map((t) => t.href)
    for (const href of ["/database/seeds", "/edge-functions", "/realtime", "/plugins"]) expect(hrefs).toContain(href)
  })
})
