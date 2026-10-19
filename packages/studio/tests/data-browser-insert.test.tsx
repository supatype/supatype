// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { insertBody, renderBrowser, type Browser } from "./data-browser-support.js"

/**
 * The data browser's Insert Row sent "" for every field left empty. On realtime's `message` that
 * was `created_at: ""`, refused with 400 (invalid input syntax for type timestamp with time zone),
 * and on a nullable column with a default it sent null, which overrode the default.
 */

let browser: Browser | null = null

afterEach(() => {
  browser?.unmount()
  browser = null
})

describe("inserting a row", () => {
  it("leaves untouched fields out, so their defaults apply", async () => {
    browser = await renderBrowser()
    await insertBody(browser.container, "mt15 test row")
    expect(browser.inserts).toEqual([{ body: "mt15 test row" }])
  })
})
