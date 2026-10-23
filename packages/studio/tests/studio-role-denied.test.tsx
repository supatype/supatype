// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { isArrayOf, isRecordOf, isShape, isString } from "../src/lib/json.js"
import { act, button, elementOf, findButton, isolateEachTest, mount, settle, testClient, testConfig, testModel } from "./support.js"

/**
 * What a Studio role sees on a screen it cannot use: one plain sentence naming the role and what it
 * cannot do, and none of the screen's controls. It used to be the upstream's own refusal ("403",
 * "Auth API error") over a form whose every save the server refused.
 */

const raw = readFileSync(join(process.cwd(), "../cli/src/role-matrix.json"), "utf8")
const parsed: unknown = JSON.parse(raw)
const isMatrix = isShape({ permissions: isRecordOf(isArrayOf(isString)) })
if (!isMatrix(parsed)) throw new Error("role-matrix.json is not the shared role document")
const matrix = parsed

function permissionsOf(role: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(matrix.permissions).map(([name, holders]) => [name, holders.includes(role)]))
}

/** Whether `role` builds the project (admins and developers), which every admin-plane route needs. */
const administers = (role: string): boolean => permissionsOf(role)["administer"] === true

const CONFIG = testConfig({
  models: [testModel({ name: "page", label: "Page", labelPlural: "Pages", tableName: "pages" })],
  globals: [{ name: "site_settings", label: "Site Settings", tableName: "_global_site_settings", apiPath: "/rest/v1/_global_site_settings", fields: [] }],
})
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

/** The server as `role` meets it: the admin plane and the auth admin API refuse who may not use them. */
function serverFor(role: string): (input: string) => Promise<Response> {
  return async (input) => {
    const path = new URL(input).pathname
    if (path.endsWith("/studio/auth/verify")) return Response.json({ role, mode: "studio", permissions: permissionsOf(role) })
    if (path.includes("/admin/v1/") || path.includes("/auth/v1/")) {
      if (!administers(role)) return Response.json({ error: "Forbidden: service_role required" }, { status: 403 })
    }
    if (path.endsWith("/admin/v1/cache")) return Response.json({ entries: [], cursor: "0" })
    if (path.endsWith("/admin/v1/config/rest")) return Response.json({ cache_max_ttl: 60, cache_tables: null, declared: {} })
    if (path.endsWith("/storage/v1/bucket")) return Response.json([{ id: "default", name: "default", public: false }])
    if (path.endsWith("/metadata")) return Response.json({ rows: [{ max_connections: "100", statement_timeout: "0" }] })
    return Response.json([])
  }
}

/**
 * The Settings screen's own tabs. The nav rail also offers a "Database" button (named by its
 * aria-label when the rail is collapsed), so the tab is looked for where the tabs are.
 */
function settingsTabs(page: HTMLElement): HTMLElement {
  return elementOf(page, '[role="tablist"][aria-label="Settings sections"]', HTMLElement)
}

async function studioAs(role: string, path: string): Promise<HTMLElement> {
  vi.stubGlobal("fetch", serverFor(role))
  const view = await mount(
    <MemoryRouter initialEntries={[path]}>
      <StudioCore config={CONFIG} client={CLIENT} />
    </MemoryRouter>,
  )
  await settle(8)
  return view.container
}

const text = (el: HTMLElement): string => el.textContent ?? ""

isolateEachTest()

describe("the response cache, for a role that cannot manage it", () => {
  it.each([
    ["a model", "/models/page/cache"],
    ["a global", "/models/globals/site_settings/cache"],
  ])("tells an editor on %s's Cache tab why, and offers no control", async (_, path) => {
    const page = await studioAs("editor", path)
    expect(text(page)).toContain("Your Studio role (editor) can't manage the response cache.")
    expect(text(page)).toContain("Ask a Studio admin or developer.")
    expect(text(page)).not.toContain("403")
    for (const control of ["Refresh", "Flush", "Save cache settings"]) expect(findButton(page, control)).toBeUndefined()
    expect(page.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it.each(["admin", "developer"])("still offers a %s every control on a model's Cache tab", async (role) => {
    const page = await studioAs(role, "/models/page/cache")
    expect(text(page)).not.toContain("Your Studio role")
    for (const control of ["Refresh", "Flush", "Save cache settings"]) expect(findButton(page, control)).toBeDefined()
  })
})

describe("the project's users, for a role that cannot manage them", () => {
  it("tells an editor why rather than showing the auth server's refusal", async () => {
    const page = await studioAs("editor", "/authentication/users")
    expect(text(page)).toContain("Your Studio role (editor) can't manage the project's users.")
    expect(text(page)).not.toContain("Auth API error")
    expect(text(page)).not.toContain("service_role required")
  })

  it("still shows a developer the users", async () => {
    const page = await studioAs("developer", "/authentication/users")
    expect(text(page)).not.toContain("Your Studio role")
  })
})

describe("a viewer, who reads and does not change", () => {
  it("browses a bucket's files with no upload or new folder", async () => {
    const page = await studioAs("viewer", "/media-storage/default/files")
    expect(text(page)).not.toContain("Your Studio role")
    expect(findButton(page, "Upload Files")).toBeUndefined()
    expect(findButton(page, "New Folder")).toBeUndefined()
  })

  it("still offers an editor uploads", async () => {
    const page = await studioAs("editor", "/media-storage/default/files")
    expect(findButton(page, "Upload Files")).toBeDefined()
  })

  it("reads the database settings, and is told why the credentials are not offered", async () => {
    const page = await studioAs("viewer", "/settings")
    await act(() => button(settingsTabs(page), "Database").click())
    await settle(8)
    expect(text(page)).toContain("Max Connections")
    expect(text(page)).toContain("Your Studio role (viewer) can't manage the database credentials.")
    expect(findButton(page, "Rotate Password")).toBeUndefined()
  })

  it("offers a developer the credentials", async () => {
    const page = await studioAs("developer", "/settings")
    await act(() => button(settingsTabs(page), "Database").click())
    await settle(8)
    expect(findButton(page, "Rotate Password")).toBeDefined()
  })
})

describe("the Studio proxy's 403, wherever a screen still meets one", () => {
  const sentence = "Studio role \"billing\" cannot perform this request"
  // The server answers with the code in `error` and the sentence in `message`. An older one put the
  // sentence in `error` alone, and Studio still reads that.
  it.each([
    ["the code and the sentence", { error: "forbidden", message: sentence }],
    ["the sentence in error, from an older server", { error: sentence }],
  ])("reads as the role sentence, not the status, from %s", async (_, refusal) => {
    vi.stubGlobal("fetch", async (input: string) => {
      const path = new URL(input).pathname
      // A server that reports no role, so nothing is gated, and then refuses the cache anyway.
      if (path.endsWith("/studio/auth/verify")) return Response.json({})
      if (path.includes("/admin/v1/")) return Response.json(refusal, { status: 403 })
      return Response.json([])
    })
    const view = await mount(
      <MemoryRouter initialEntries={["/models/page/cache"]}>
        <StudioCore config={CONFIG} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle(8)
    expect(text(view.container)).toContain("Your Studio role can't manage the response cache.")
    expect(text(view.container)).not.toMatch(/^403$|>403</)
  })
})
