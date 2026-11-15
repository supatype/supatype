import { describe, expect, it } from "vitest"
import { settleRenames } from "../src/destructive-consent.js"
import type { RenameCandidate } from "../src/engine-client.js"

/**
 * A push that dropped one table and added eight printed eight `supatype rename` lines, one per new
 * table (0.9.3 Docker run: `_global_site_settings` to article, bid, lot and five more). A dropped
 * table or column with more than three possible new names is now one line with a placeholder.
 */
const table = (from: string, to: string): RenameCandidate => ({ kind: "table", table: from, from, to })
const settle = (candidates: RenameCandidate[]) =>
  settleRenames({ renameCandidates: async () => candidates, renameWriter: { write: async () => {} } }, false, async () => false)

describe("the rename commands a refused push names", () => {
  it("names each candidate when a source has three or fewer", async () => {
    const { hint } = await settle([table("posts", "articles"), table("posts", "entries")])
    expect(hint).toEqual([
      "If any of these was a rename, record it and push again:",
      "  supatype rename posts articles",
      "  supatype rename posts entries",
    ])
  })

  it("names one line with a placeholder when a source has more than three", async () => {
    const news = ["article", "bid", "lot", "note", "tag"]
    const { hint } = await settle(news.map((to) => table("_global_site_settings", to)))
    expect(hint).toEqual([
      "If any of these was a rename, record it and push again:",
      "  supatype rename _global_site_settings <new name>   (5 new tables could be it)",
    ])
  })
})
