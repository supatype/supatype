// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"
import { KEYLESS_COLUMNS, renderBrowser } from "./data-browser-support.js"
import { clickHeader, lastOrder, renderList } from "./list-view-support.js"
import { testConfig, testField, testModel } from "./support.js"

/**
 * Lists asked for an order only once a column header had been clicked, so Postgres returned rows
 * in whatever order it found them and paging could repeat or skip a row. A list now starts in the
 * engine's default order, and every order ends on the primary key so rows that tie on the sorted
 * column cannot trade places between two page requests.
 */

let unmount: (() => void) | null = null

afterEach(() => {
  unmount?.()
  unmount = null
})

const NEWEST_FIRST = { column: "created_at", ascending: false }
const TITLE = testField({ name: "title", label: "Title" })

describe("reading the order from the engine", () => {
  const engineModel = (extra: Record<string, unknown>) =>
    normalizeAdminConfig({ models: [{ name: "Talk", tableName: "talk", fields: [], ...extra }] }).models[0]

  it("keeps the engine's default sort and every key column", () => {
    const talk = engineModel({ defaultSort: { field: "created_at", direction: "desc" }, primaryKey: ["tenant", "slug"] })
    expect(talk?.defaultSort).toEqual(NEWEST_FIRST)
    expect(talk?.primaryKeyColumns).toEqual(["tenant", "slug"])
    expect(talk?.primaryKey).toBe("tenant")
  })

  it("reads an older engine that sends no key as keyed on id", () => {
    const talk = engineModel({})
    expect(talk?.primaryKey).toBe("id")
    expect(talk?.primaryKeyColumns).toBeUndefined()
    expect(talk?.defaultSort).toBeUndefined()
  })
})

describe("a model's list order", () => {
  it("starts in the engine's default order with the primary key after it", async () => {
    const list = await renderList(testModel({ defaultSort: NEWEST_FIRST, primaryKeyColumns: ["id"] }))
    unmount = list.unmount
    expect(lastOrder(list.reads)).toBe("created_at.desc.nullslast,id.desc.nullslast")
  })

  it("keeps the primary key after a column the user sorts by", async () => {
    const model = testModel({ defaultSort: NEWEST_FIRST, fields: [TITLE], listColumns: ["title"] })
    const list = await renderList(model)
    unmount = list.unmount
    await clickHeader(list.container, "Title")
    expect(lastOrder(list.reads)).toBe("title.asc.nullslast,id.asc.nullslast")
  })

  it("ends on every column of a composite key", async () => {
    const list = await renderList(testModel({ defaultSort: NEWEST_FIRST, primaryKeyColumns: ["tenant", "slug"] }))
    unmount = list.unmount
    expect(lastOrder(list.reads)).toBe("created_at.desc.nullslast,tenant.desc.nullslast,slug.desc.nullslast")
  })

  it("orders by the key alone for an engine that sends no default", async () => {
    const list = await renderList(testModel())
    unmount = list.unmount
    expect(lastOrder(list.reads)).toBe("id.asc.nullslast")
  })
})

describe("the data browser's order", () => {
  const messageModel = testModel({ name: "Message", tableName: "message", defaultSort: NEWEST_FIRST })

  it("orders a table no model describes by its primary key", async () => {
    const browser = await renderBrowser()
    unmount = browser.unmount
    expect(lastOrder(browser.reads)).toBe("id.asc.nullslast")
  })

  it("starts a model's table in the model's default order", async () => {
    const browser = await renderBrowser({ config: testConfig({ models: [messageModel] }) })
    unmount = browser.unmount
    expect(lastOrder(browser.reads)).toBe("created_at.desc.nullslast,id.desc.nullslast")
  })

  it("keeps the primary key after a column the user sorts by", async () => {
    const browser = await renderBrowser({ config: testConfig({ models: [messageModel] }) })
    unmount = browser.unmount
    await clickHeader(browser.container, "body")
    expect(lastOrder(browser.reads)).toBe("body.asc.nullslast,id.asc.nullslast")
  })

  it("falls back to the row's position for a table with no primary key", async () => {
    const browser = await renderBrowser({ columns: KEYLESS_COLUMNS })
    unmount = browser.unmount
    expect(lastOrder(browser.reads)).toBe("ctid.asc.nullslast")
  })
})
