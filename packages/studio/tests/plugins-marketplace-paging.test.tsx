// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { PluginsMarketplace } from "../src/views/PluginsMarketplace.js"

/**
 * The plugins marketplace pages through npm's search results. It showed the first 50 and stopped,
 * with no way to see the rest. The stub answers like the npm registry's search: `size`, `from`,
 * and the `total` that match.
 */

const PACKAGES = Array.from({ length: 120 }, (_, i) => ({
  package: { name: `supatype-plugin-${i + 1}`, version: "1.0.0", description: "", keywords: [], links: { npm: "https://npm" }, date: "2026-10-01T00:00:00Z" },
}))

let root: Root | null = null
let container: HTMLElement
let froms: string[] = []

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("the plugins marketplace", () => {
  it("pages to the results after the first 50", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    froms = []
    vi.stubGlobal("fetch", async (raw: string) => {
      const url = new URL(raw)
      const from = Number(url.searchParams.get("from") ?? "0")
      froms.push(String(from))
      const size = Number(url.searchParams.get("size") ?? "20")
      return Response.json({ objects: PACKAGES.slice(from, from + size), total: PACKAGES.length })
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<PluginsMarketplace />))
    await settle()
    expect(container.textContent).toContain("Page 1 of 3 (120)")
    const next = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next")
    await act(async () => next?.click())
    await settle()
    expect(froms.at(-1)).toBe("50")
    expect(container.textContent).toContain("supatype-plugin-51")
  })
})
