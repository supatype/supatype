// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { browseTotal, countModeFor } from "../src/lib/browse-paging.js"
import { button, renderBrowser, type Browser } from "./data-browser-support.js"

/**
 * The data browser paged over the planner's estimate of a table's size, so realtime's `message`
 * (30 rows, last sampled at 18) said "Page 1 of 1 (18 rows)" at 25 a page and rows 26 to 30 were
 * out of reach.
 */

let browser: Browser | null = null

afterEach(() => {
  browser?.unmount()
  browser = null
})

describe("paging the data browser", () => {
  it("pages over the table's real row count, not the planner's estimate", async () => {
    browser = await renderBrowser()
    expect(browser.container.textContent).toContain("Page 1 of 2 (30 rows)")
    expect(button(browser.container, "Next").disabled).toBe(false)
  })

  it("on a table too big to count, still offers the next page after a full one", () => {
    expect(countModeFor(5_000_000)).toBe("estimated")
    expect(countModeFor(-1)).toBe("exact")
    expect(browseTotal({ count: 18, mode: "estimated", from: 0, rows: 25 }, 25)).toBe(26)
    expect(browseTotal({ count: 18, mode: "estimated", from: 25, rows: 5 }, 25)).toBe(30)
    expect(browseTotal({ count: 25, mode: "exact", from: 0, rows: 25 }, 25)).toBe(25)
  })
})
