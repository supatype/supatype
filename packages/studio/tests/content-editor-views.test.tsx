// @vitest-environment jsdom
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { LivePreviewPane } from "../src/components/LivePreviewPane.js"
import { ButtonLink, TextLink } from "../src/components/ui.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { StudioCore } from "../src/StudioCore.js"
import { MediaLibrary } from "../src/views/MediaLibrary.js"
import { act, button, elementOf, isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"
import { lastOrder, renderList } from "./list-view-support.js"

/**
 * The content list, the media library, the live preview and the header's docs link are drawn from
 * the shared primitives (`data-ui` names which), and the list still sorts, selects, pages and opens
 * records, now from the keyboard as well as the pointer.
 */

isolateEachTest()

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
/** Storage is read with the service role, as the media library reads it. */
const STORAGE_CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", serviceRoleKey: "service" })
const TITLE = testField({ name: "title", label: "Title" })
const POSTS = testModel({ fields: [TITLE], listColumns: ["title"], searchFields: ["title"] })
const ROWS = [{ id: "p1", title: "First post" }, { id: "p2", title: "Second post" }]

const primitive = (el: Element | null): string | null => el?.getAttribute("data-ui") ?? null

async function key(el: Element, name: string): Promise<void> {
  await act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })) })
  await settle()
}

describe("the content list", () => {
  it("is the shared table card, with shared headers, tick boxes, search and paging", async () => {
    const { container } = await renderList(POSTS, ROWS)
    const table = container.querySelector("[data-ui=table-card] table")
    expect(table).not.toBeNull()
    expect(Array.from(container.querySelectorAll("thead th")).map(primitive)).toEqual(["th", "th"])
    expect(container.querySelectorAll("[data-ui=checkbox]")).toHaveLength(3)
    expect(primitive(container.querySelector("input[type=search]"))).toBe("input")
    expect(primitive(button(container, "Previous"))).toBe("button")
    expect(primitive(button(container, "Next"))).toBe("button")
    expect(Array.from(container.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[1]?.textContent)).toEqual(["First post", "Second post"])
  })

  it("sorts a column from its header's shared sort button, saying which way", async () => {
    const { container, reads } = await renderList(POSTS, ROWS)
    const sort = elementOf(container, "thead [data-ui=sort-button]", HTMLButtonElement)
    expect(sort.textContent).toBe("Title")
    await act(() => { sort.click() })
    await settle()
    expect(lastOrder(reads)).toMatch(/^title[.]asc/)
    expect(container.querySelector("thead th[aria-sort]")?.getAttribute("aria-sort")).toBe("ascending")
    await act(() => { elementOf(container, "thead [data-ui=sort-button]", HTMLButtonElement).click() })
    await settle()
    expect(container.querySelector("thead th[aria-sort]")?.getAttribute("aria-sort")).toBe("descending")
  })

  it("opens a record from a click on its row or Enter on the focused row", async () => {
    const onNavigate = vi.fn()
    const { container } = await renderList(POSTS, ROWS, onNavigate)
    const [first, second] = Array.from(container.querySelectorAll<HTMLElement>("tbody tr"))
    if (!first || !second) throw new Error("no rows")
    await act(() => { first.click() })
    expect(onNavigate).toHaveBeenLastCalledWith("/models/post/p1")
    expect(second.tabIndex).toBe(0)
    await key(second, "Enter")
    expect(onNavigate).toHaveBeenLastCalledWith("/models/post/p2")
  })

  it("ticks a row without opening it", async () => {
    const onNavigate = vi.fn()
    const { container } = await renderList(POSTS, ROWS, onNavigate)
    const tick = elementOf(container, "input[aria-label='Select row p1']", HTMLInputElement)
    await act(() => { tick.click() })
    await key(tick, "Enter")
    expect(tick.checked).toBe(true)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(container.textContent).toContain("1 selected")
  })
})

describe("the media library", () => {
  const BUCKET = { id: "docs", name: "docs", public: false, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }
  const FILE = { id: "o1", bucket_id: "docs", name: "report.txt", owner: null, metadata: { size: 1, mimetype: "text/plain" }, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z", last_accessed_at: "2026-10-19T10:00:00Z", size: 1, mimetype: "text/plain" }

  /** The library on the docs bucket; a delete is answered by `onDelete`, by default as removed. */
  async function library(onDelete: () => Response = () => Response.json([{ name: "report.txt", bucket_id: "docs" }])): Promise<HTMLElement> {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (init?.method === "DELETE") return onDelete()
      return url.endsWith("/storage/v1/bucket") ? Response.json([BUCKET])
      : url.includes("/storage/v1/object/list/docs") ? Response.json([FILE], { headers: { "X-Total-Count": "1" } })
      : Response.json([])
    })
    const { container } = await mount(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={STORAGE_CLIENT}><MediaLibrary /></AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
    await settle()
    const select = elementOf(container, "select", HTMLSelectElement)
    await act(() => { select.value = "docs"; select.dispatchEvent(new Event("change", { bubbles: true })) })
    await settle()
    return container
  }

  it("picks a bucket from the shared select and searches with the shared input", async () => {
    const container = await library()
    expect(primitive(container.querySelector("select"))).toBe("select")
    expect(primitive(container.querySelector("input[type=search]"))).toBe("input")
    expect(container.querySelector("[data-ui=file-input]")).not.toBeNull()
    expect(container.querySelector("[data-ui=card]")?.textContent).toContain("report.txt")
  })

  /** Delete on the file, answered yes. */
  async function deleteFile(container: HTMLElement): Promise<void> {
    await act(() => { button(container, "Delete").click() })
    await act(() => { button(document.body.querySelector("[role=alertdialog]") ?? document.body, "Delete file").click() })
    await settle()
  }

  // A refused delete was dropped: the file stayed and nothing said why.
  it("says why when the server refuses a delete", async () => {
    const container = await library(() => Response.json({ statusCode: "403", error: "Forbidden", message: "Not allowed to delete" }, { status: 403 }))
    await deleteFile(container)
    expect(container.querySelector("[data-ui=error-banner]")?.textContent).toContain("Not allowed to delete")
  })

  it("says so when the server keeps a file it was asked to delete", async () => {
    const container = await library(() => Response.json([]))
    await deleteFile(container)
    expect(container.querySelector("[data-ui=error-banner]")?.textContent).toContain("1 of 1 object could not be deleted")
  })

  it("shows no error when the file goes", async () => {
    const container = await library()
    await deleteFile(container)
    expect(container.querySelector("[data-ui=error-banner]")).toBeNull()
  })

  it("lists the files in the shared table card", async () => {
    const container = await library()
    await act(() => { button(container, "List").click() })
    await settle()
    expect(container.querySelector("[data-ui=table-card] tbody")?.textContent).toContain("report.txt")
  })
})

describe("the live preview", () => {
  it("opens the preview in a new tab from the shared button link", () => {
    const html = renderToStaticMarkup(<LivePreviewPane previewUrl="http://localhost:3001/p" values={{}} model={testModel()} awaitingFirstSave={false} />)
    // One anchor carrying all three, in whatever order React writes them.
    expect(html).toMatch(/<a (?=[^>]*data-ui="button-link")(?=[^>]*href="http:\/\/localhost:3001\/p")(?=[^>]*target="_blank")/)
  })
})

describe("a link to a route", () => {
  it("follows the router, under Studio's base path, wearing the shared face", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter basename="/studio" initialEntries={["/studio"]}>
        <ButtonLink to="/models/post" size="xs">Posts</ButtonLink>
        <TextLink to="/migrations">History</TextLink>
      </MemoryRouter>,
    )
    expect(html).toMatch(/<a (?=[^>]*data-ui="button-link")(?=[^>]*href="\/studio\/models\/post")/)
    expect(html).toMatch(/<a (?=[^>]*data-ui="text-link")(?=[^>]*href="\/studio\/migrations")/)
  })
})

describe("the header's docs link", () => {
  it("is the shared icon link, named for a screen reader", async () => {
    vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}))
    await mount(
      <MemoryRouter initialEntries={["/models/post"]}>
        <StudioCore config={testConfig({ models: [testModel()] })} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle()
    const docs = document.querySelector("header [aria-label=Documentation]")
    expect(docs?.tagName).toBe("A")
    expect(primitive(docs)).toBe("icon-link")
    expect(docs?.getAttribute("title")).toBe("Documentation")
  })
})
