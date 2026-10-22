// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { CREATED_ID, editFirstRowCell, firstRowCell, insertBody, renderBrowser } from "./data-browser-support.js"
import { act, button, findButton, isolateEachTest, settle, testConfig, testModel } from "./support.js"

/**
 * The data browser's cell edit wrote the live row of a model with drafts directly: the engine's
 * drafts-only trigger lets Studio's writes through, so a change meant for review went live on
 * Enter. On a drafts model the editor now chooses: save the change as a draft, or save and publish
 * it. A model without drafts saves straight to the row as before.
 */

isolateEachTest()

const BODY = 1
const DRAFTS = { drafts: true, keep: 10, versionsTable: "message_versions", localizedColumns: [] }
const draftsConfig = testConfig({ models: [testModel({ name: "message", tableName: "message", versions: DRAFTS })] })
const saveDraftsCall = (publish: boolean): Record<string, unknown> => ({
  method: "POST",
  path: "/rest/v1/rpc/save_drafts",
  body: { model_table: "message", record_ids: ["1"], data: { body: "edited" }, publish },
})

/** Click `choice` in the save question; the form behind it has a Cancel of its own. */
async function answer(container: HTMLElement, choice: string): Promise<void> {
  const dialog = container.querySelector('[role="dialog"]')
  if (dialog === null) throw new Error("no save question is open")
  await act(async () => button(dialog, choice).click())
  await settle()
}

describe("editing a cell on a model with drafts", () => {
  it("asks whether to save as a draft or save and publish, and writes nothing yet", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await editFirstRowCell(browser.container, BODY, "edited")
    const dialog = browser.container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(findButton(dialog ?? browser.container, "Save as draft")).toBeDefined()
    expect(findButton(dialog ?? browser.container, "Save and publish")).toBeDefined()
    expect(browser.writes).toEqual([])
  })

  it("Save as draft saves a draft and keeps showing the live value, marked as having one", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await editFirstRowCell(browser.container, BODY, "edited")
    await answer(browser.container, "Save as draft")
    expect(browser.writes).toEqual([saveDraftsCall(false)])
    const cell = firstRowCell(browser.container, BODY)
    expect(cell.textContent).toContain("message 1")
    expect(cell.textContent).not.toContain("edited")
    expect(cell.textContent).toContain("Draft")
    expect(browser.container.textContent).toContain("The live value is unchanged until the record is published.")
  })

  it("Save and publish saves the draft and publishes it in the same call", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await editFirstRowCell(browser.container, BODY, "edited")
    await answer(browser.container, "Save and publish")
    expect(browser.writes).toEqual([saveDraftsCall(true)])
  })

  it("Cancel writes nothing and leaves the value as it was", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await editFirstRowCell(browser.container, BODY, "edited")
    await answer(browser.container, "Cancel")
    expect(browser.writes).toEqual([])
    expect(firstRowCell(browser.container, BODY).textContent).toBe("message 1")
  })
})

/**
 * Insert Row on a model with drafts inserted the live row, so a new record was public at once. It
 * now asks as the record editor's create does: create it as a draft through `create_record`, or
 * create it and publish it with `publish`.
 */
describe("inserting a row on a model with drafts", () => {
  const createCall = { method: "POST", path: "/rest/v1/rpc/create_record", body: { model_table: "message", data: { body: "new row" } } }

  it("asks whether to save as a draft or save and publish, and writes nothing yet", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await insertBody(browser.container, "new row")
    const dialog = browser.container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute("aria-label")).toBe("Create this record in message?")
    expect(findButton(dialog ?? browser.container, "Save and publish")).toBeDefined()
    expect(browser.inserts).toEqual([])
    expect(browser.writes).toEqual([])
  })

  it("Save as draft creates the record through create_record, unpublished", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await insertBody(browser.container, "new row")
    await answer(browser.container, "Save as draft")
    expect(browser.inserts).toEqual([])
    expect(browser.writes).toEqual([createCall])
    expect(browser.container.textContent).toContain("The new record is saved as a draft. It is not live until it is published.")
    expect(findButton(browser.container, "Insert Row")).toBeUndefined()
  })

  it("Save and publish creates the record, then publishes it", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await insertBody(browser.container, "new row")
    await answer(browser.container, "Save and publish")
    expect(browser.inserts).toEqual([])
    const publishCall = { method: "POST", path: "/rest/v1/rpc/publish", body: { model_table: "message", record_id: CREATED_ID } }
    expect(browser.writes).toEqual([createCall, publishCall])
  })

  it("Cancel creates nothing and keeps the form as typed", async () => {
    const browser = await renderBrowser({ config: draftsConfig })
    await insertBody(browser.container, "new row")
    await answer(browser.container, "Cancel")
    expect(browser.writes).toEqual([])
    expect(findButton(browser.container, "Insert Row")).toBeDefined()
  })
})

describe("inserting a row on a model without drafts", () => {
  it("inserts the row, with no question", async () => {
    const browser = await renderBrowser()
    await insertBody(browser.container, "new row")
    expect(findButton(browser.container, "Save as draft")).toBeUndefined()
    expect(browser.inserts).toEqual([{ body: "new row" }])
    expect(browser.writes).toEqual([])
  })
})

describe("editing a cell on a model without drafts", () => {
  it("saves straight to the row, with no question", async () => {
    const browser = await renderBrowser()
    await editFirstRowCell(browser.container, BODY, "edited")
    expect(findButton(browser.container, "Save as draft")).toBeUndefined()
    expect(browser.writes).toEqual([{ method: "PATCH", path: "/rest/v1/message?id=eq.1", body: { body: "edited" } }])
    expect(firstRowCell(browser.container, BODY).textContent).toBe("edited")
  })
})
