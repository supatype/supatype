// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { MediaLibrary } from "../src/views/MediaLibrary.js"
import { ImageWidget } from "../src/widgets/ImageWidget.js"
import { press } from "./dialog-support.js"
import { act, advance, elementOf, isolateEachTest, mount, settle, testClient, testConfig, testField } from "./support.js"

/**
 * Studio's file views read a folder a page at a time and load more on request. They read one page
 * (the storage server's default of 100, or a fixed 100) and stopped, so in a bigger folder the rest
 * of the files were neither listed nor found.
 *
 * The stub answers like packages/storage's list route: `limit` (100 when absent) and `offset`.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", serviceRoleKey: "service" })
const OBJECTS = Array.from({ length: 150 }, (_, i) => ({
  id: `o${i + 1}`,
  bucket_id: "docs",
  name: `file-${String(i + 1).padStart(3, "0")}.txt`,
  owner: null,
  metadata: { size: 1, mimetype: "text/plain" },
  created_at: "2026-10-19T10:00:00Z",
  updated_at: "2026-10-19T10:00:00Z",
  last_accessed_at: "2026-10-19T10:00:00Z",
  size: 1,
  mimetype: "text/plain",
}))
/** Images for the picker: more than the 200 it used to read. */
const IMAGES = Array.from({ length: 250 }, (_, i) => ({ ...OBJECTS[0]!, id: `i${i + 1}`, bucket_id: "images", name: `img-${String(i + 1).padStart(3, "0")}.png` }))
const BUCKET = { id: "docs", name: "docs", public: false, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }

/** The offset and search text of every list request a file view has sent. */
interface Requests {
  offsets: number[]
  searches: string[]
}

/** A file view on screen, and the list requests it has sent. */
interface Folder extends Requests {
  container: HTMLElement
}

/** Answers like the storage API: a page of `limit` from `offset`, filtered by `search`. */
function answer(sent: Requests, url: string, init?: RequestInit): Response {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([BUCKET])
  const listed = url.includes("/storage/v1/object/list/docs") ? OBJECTS : url.includes("/storage/v1/object/list/images") ? IMAGES : null
  if (listed === null) return Response.json([])
  const body: unknown = JSON.parse(String(init?.body ?? "{}"))
  const at = typeof body === "object" && body !== null ? body : {}
  const offset = "offset" in at && typeof at.offset === "number" ? at.offset : 0
  const limit = "limit" in at && typeof at.limit === "number" ? at.limit : 100
  const search = "search" in at && typeof at.search === "string" ? at.search : ""
  sent.offsets.push(offset)
  sent.searches.push(search)
  const matching = listed.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
  return Response.json(matching.slice(offset, offset + limit), { headers: { "X-Total-Count": String(matching.length) } })
}

async function show(ui: React.ReactElement, at: string): Promise<Folder> {
  const sent: Requests = { offsets: [], searches: [] }
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => answer(sent, url, init))
  const { container } = await mount(
    <MemoryRouter initialEntries={[at]}>
      <AdminConfigContext.Provider value={testConfig()}>
        <AdminClientContext.Provider value={CLIENT}>
          <Routes>
            <Route path="/media-storage/:bucket/files" element={ui} />
            <Route path="/media" element={ui} />
          </Routes>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { container, ...sent }
}

function shown(container: HTMLElement): number {
  return new Set(container.textContent?.match(/file-\d{3}\.txt/g) ?? []).size
}

/** Picks the `docs` bucket in the media library's bucket menu. */
async function pickDocs(container: HTMLElement): Promise<void> {
  const select = elementOf(container, "select", HTMLSelectElement)
  await act(() => {
    select.value = "docs"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

/** Types into the view's search box and waits past its debounce. */
async function search(text: string): Promise<void> {
  const input = elementOf(document.body, "input[type=search], input[placeholder^='Search']", HTMLInputElement)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await advance(400, 1)
  await settle()
}

isolateEachTest()

function images(): number {
  return new Set(Array.from(document.body.querySelectorAll("img")).map((i) => i.getAttribute("alt") ?? "").filter((a) => a.startsWith("img-"))).size
}

const IMAGE_FIELD = testField({ name: "cover", widget: "image", options: { bucket: "images" } })
const PICKER = <ImageWidget config={IMAGE_FIELD} value={null} onChange={() => undefined} readOnly={false} />

// The search box asks the server, so it finds files past the ones loaded, and the view says how
// many match. It filtered only the loaded page in the browser.
describe("searching a folder", () => {
  it("asks the server in the storage browser and shows the total", async () => {
    const { container, searches } = await show(<StorageBrowser />, "/media-storage/docs/files")
    expect(container.textContent).toContain("100 of 150")
    await search("FILE-14")
    expect(searches.at(-1)).toBe("FILE-14")
    expect(shown(container)).toBe(10)
    expect(container.textContent).toContain("10 of 10")
  })

  it("asks the server in the media library and shows the total", async () => {
    const { container, searches } = await show(<MediaLibrary />, "/media")
    await pickDocs(container)
    expect(container.textContent).toContain("100 of 150")
    await search("file-149")
    expect(searches.at(-1)).toBe("file-149")
    expect(shown(container)).toBe(1)
  })

  it("asks the server in the image picker and shows the total", async () => {
    const { container, searches } = await show(PICKER, "/media")
    await press("Select from bucket", container)
    expect(document.body.textContent).toContain("100 of 250")
    await search("img-250")
    expect(searches.at(-1)).toBe("img-250")
    expect(images()).toBe(1)
  })
})

describe("a folder with more files than one page", () => {
  it("lists the rest in the image picker on request", async () => {
    const { container } = await show(PICKER, "/media")
    await press("Select from bucket", container)
    expect(images()).toBeLessThan(250)
    await press("Load more")
    await press("Load more")
    expect(images()).toBe(250)
  })

  it("lists the rest in the storage browser on request", async () => {
    const { container, offsets } = await show(<StorageBrowser />, "/media-storage/docs/files")
    expect(shown(container)).toBe(100)
    await press("Load more", container)
    expect(offsets.at(-1)).toBe(100)
    expect(shown(container)).toBe(150)
  })

  it("lists the rest in the media library on request", async () => {
    const { container, offsets } = await show(<MediaLibrary />, "/media")
    await pickDocs(container)
    expect(shown(container)).toBe(100)
    await press("Load more", container)
    expect(offsets.at(-1)).toBe(100)
    expect(shown(container)).toBe(150)
  })
})
