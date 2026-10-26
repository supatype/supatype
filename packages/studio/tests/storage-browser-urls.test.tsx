// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { browserStorageUrl } from "../src/lib/storage-ref.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { testClient, testConfig } from "./support.js"

/**
 * Storage browser thumbnails load as the signed-in Studio admin, in a public bucket and a private one.
 *
 * Studio's client talks through `/studio/proxy`, which answers only requests carrying the Studio
 * session. The thumbnails' URLs were built on that base, and an `<img>` sends no session, so every
 * one answered 401 and showed "IMG". A public object or a signed token needs no session, so the
 * browser loads them from the gateway's own `/storage/v1/` route.
 */

const GATEWAY = "http://localhost:8000"
const PROXY = `${GATEWAY}/studio/proxy`
const CLIENT = testClient({ url: PROXY, token: "token" })

function bucket(name: string, isPublic: boolean): Record<string, unknown> {
  return { id: name, name, public: isPublic, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }
}

const PHOTO = {
  id: "o1", bucket_id: "", name: "photo.png", owner: null,
  metadata: { size: 10, mimetype: "image/png" },
  created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z", last_accessed_at: "2026-10-19T10:00:00Z",
  size: 10, mimetype: "image/png",
}

/** Answers as packages/storage does: a signed URL is a path relative to the storage API. */
async function answer(url: string): Promise<Response> {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([bucket("pics", true), bucket("secret", false)])
  if (url.includes("/storage/v1/object/list/")) return Response.json([PHOTO], { headers: { "X-Total-Count": "1" } })
  if (url.includes("/storage/v1/object/sign/secret/photo.png")) {
    return Response.json({ signedURL: "/object/sign/secret/photo.png?token=t0k" })
  }
  return Response.json([])
}

let root: Root | null = null
let container: HTMLElement

async function mount(at: string): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", (url: string) => answer(url))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/media-storage/:bucket/files" element={<StorageBrowser />} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function thumbnailSources(): string[] {
  return Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "")
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("storage browser thumbnails", () => {
  it("load a public bucket's image from the gateway, not the session proxy", async () => {
    await mount("/media-storage/pics/files")
    expect(thumbnailSources()).toEqual([`${GATEWAY}/storage/v1/object/public/pics/photo.png`])
  })

  it("load a private bucket's image from a signed URL on the gateway", async () => {
    await mount("/media-storage/secret/files")
    expect(thumbnailSources()).toEqual([`${GATEWAY}/storage/v1/object/sign/secret/photo.png?token=t0k`])
  })
})

describe("browserStorageUrl", () => {
  it("moves a storage URL off the session proxy and keeps its query", () => {
    expect(browserStorageUrl(`${PROXY}/`, `${PROXY}/storage/v1/object/sign/b/a.png?token=x`))
      .toBe(`${GATEWAY}/storage/v1/object/sign/b/a.png?token=x`)
  })

  it("moves a storage URL built for another origin to the gateway", () => {
    expect(browserStorageUrl(PROXY, "http://server:9999/storage/v1/object/public/b/a.png"))
      .toBe(`${GATEWAY}/storage/v1/object/public/b/a.png`)
  })

  it("leaves a direct client's URLs and anything outside storage as they are", () => {
    expect(browserStorageUrl(GATEWAY, `${GATEWAY}/storage/v1/object/public/b/a.png`))
      .toBe(`${GATEWAY}/storage/v1/object/public/b/a.png`)
    expect(browserStorageUrl(PROXY, "https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png")
  })
})
