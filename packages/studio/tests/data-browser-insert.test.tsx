// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { insertBody, renderBrowser } from "./data-browser-support.js"
import { button, isolateEachTest } from "./support.js"

/**
 * The data browser's Insert Row sent "" for every field left empty. On realtime's `message` that
 * was `created_at: ""`, refused with 400 (invalid input syntax for type timestamp with time zone),
 * and on a nullable column with a default it sent null, which overrode the default.
 */

isolateEachTest()

describe("inserting a row", () => {
  it("leaves untouched fields out, so their defaults apply", async () => {
    const browser = await renderBrowser()
    await insertBody(browser.container, "mt15 test row")
    expect(browser.inserts).toEqual([{ body: "mt15 test row" }])
  })
})

/**
 * A refused insert showed Postgres's text as it came. It is said plainly now, under the column it
 * names, with the server's words behind the banner's details toggle.
 */
describe("an insert the database refuses", () => {
  const UNIQUE = {
    status: 409,
    body: {
      code: "23505",
      message: 'duplicate key value violates unique constraint "message_body_key"',
      details: "Key (body)=(mt17 taken) already exists.",
    },
  }

  it("says which column clashed, under its input, without the raw SQL in the banner", async () => {
    const browser = await renderBrowser({ insertRefusal: UNIQUE })
    await insertBody(browser.container, "mt17 taken")
    const banner = browser.container.querySelector('[data-ui="error-banner-message"]')?.textContent
    expect(banner).toBe("body is already used by another record")
    const form = button(browser.container, "Insert Row").closest("[class*='p-4']")
    expect(form?.textContent).toContain("is already used by another record")
    expect(browser.container.querySelector('[data-ui="error-banner"] details')?.textContent).toContain("message_body_key")
  })
})
