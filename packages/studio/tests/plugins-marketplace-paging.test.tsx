// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { PluginsMarketplace } from "../src/views/PluginsMarketplace.js"
import { isolateEachTest, mount, settle } from "./support.js"

/**
 * The plugins marketplace pages through npm's search results. It showed the first 50 and stopped,
 * with no way to see the rest. The stub answers like the npm registry's search: `size`, `from`,
 * and the `total` that match.
 */

const PACKAGES = Array.from({ length: 120 }, (_, i) => ({
  package: { name: `supatype-plugin-${i + 1}`, version: "1.0.0", description: "", keywords: [], links: { npm: "https://npm" }, date: "2026-10-01T00:00:00Z" },
}))

isolateEachTest()

describe("the plugins marketplace", () => {
  it("pages to the results after the first 50", async () => {
    const froms: string[] = []
    vi.stubGlobal("fetch", async (raw: string) => {
      const url = new URL(raw)
      const from = Number(url.searchParams.get("from") ?? "0")
      froms.push(String(from))
      const size = Number(url.searchParams.get("size") ?? "20")
      return Response.json({ objects: PACKAGES.slice(from, from + size), total: PACKAGES.length })
    })
    const { container } = await mount(<PluginsMarketplace />)
    await settle()
    expect(container.textContent).toContain("Page 1 of 3 (120)")
    const next = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next")
    await act(async () => next?.click())
    await settle()
    expect(froms.at(-1)).toBe("50")
    expect(container.textContent).toContain("supatype-plugin-51")
  })
})
