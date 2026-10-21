// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { isArrayOf, isRecordOf, isShape, isString } from "../src/lib/json.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { hiddenNavItems } from "../src/components/Sidebar.js"
import { bucketManagementOffered, offers, projectKeysOffered, userAdministrationOffered } from "../src/lib/capability-offers.js"
import { sqlEditorOffered } from "../src/lib/sql-editor-access.js"
import { testClient, testConfig } from "./support.js"

/**
 * What each Studio role is offered, from the shared role matrix the server enforces (owner decision
 * 2026-10-21): editors and viewers work with content; developers get everything an admin does
 * (bucket management, the project's users, its keys, CORS, the SQL editor and the admin plane)
 * except granting Studio roles, which stays the admin's.
 */

// jsdom gives this module no file URL, so the shared document is found from the package root.
const raw = readFileSync(join(process.cwd(), "../cli/src/role-matrix.json"), "utf8")
const parsed: unknown = JSON.parse(raw)
const isMatrix = isShape({ selfHostRoles: isArrayOf(isString), permissions: isRecordOf(isArrayOf(isString)) })
if (!isMatrix(parsed)) throw new Error("role-matrix.json is not the shared role document")
const matrix = parsed

/** A role's permissions as the server's verify route reports them. */
function permissionsOf(role: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(matrix.permissions).map(([name, holders]) => [name, holders.includes(role)]))
}

const capabilityOf = (role: string) => ({ role, permissions: permissionsOf(role) })

describe("what each Studio role is offered", () => {
  it.each([
    ["admin", true, true],
    ["developer", true, false],
    ["editor", false, false],
    ["viewer", false, false],
  ])("%s: buckets, users, keys, CORS, SQL and administration %s; Studio members %s", (role, builds, grants) => {
    const capability = capabilityOf(role)
    expect(offers(capability, "manageDomains")).toBe(builds)
    expect(offers(capability, "administer")).toBe(builds)
    expect(bucketManagementOffered(capability)).toBe(builds)
    expect(userAdministrationOffered(capability)).toBe(builds)
    expect(projectKeysOffered(capability)).toBe(builds)
    expect(sqlEditorOffered(capability)).toBe(builds)
    expect(capability.permissions["manageMembers"]).toBe(grants)
    expect(hiddenNavItems(capability).has("auth")).toBe(!builds)
  })

  it("hides nothing before the server has answered", () => {
    const unresolved = { role: null, permissions: {} }
    expect(hiddenNavItems(unresolved).size).toBe(0)
    expect(bucketManagementOffered(unresolved)).toBe(true)
  })
})

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
let root: Root | null = null
let container: HTMLElement

/** Storage with no buckets yet, seen by `role`. */
async function mountStorage(role: string): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role, mode: "studio", permissions: permissionsOf(role) })
    return Response.json([])
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/media-storage"]}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/media-storage" element={<StorageBrowser />} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("Storage", () => {
  it("offers an editor no bucket to create, and says who creates them", async () => {
    await mountStorage("editor")
    expect(container.textContent).toContain("No buckets yet")
    expect(container.textContent).toContain("An admin or developer creates buckets")
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Create Bucket")).toBe(false)
  })

  it("offers a developer a bucket to create", async () => {
    await mountStorage("developer")
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Create Bucket")).toBe(true)
  })
})
