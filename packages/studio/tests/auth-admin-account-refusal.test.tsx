// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { authRefusalText } from "../src/lib/auth-refusal.js"
import { refusalMessage } from "../src/hooks/useEmailTemplate.js"
import { testClient } from "./support.js"

/**
 * A developer may administer users but not a Studio admin's account: the server refuses with
 * `403 {"error":"Only a Studio admin can change another admin's account."}`. Studio said only
 * "Auth API error", and offered Disable on the admin's row (fresh-test local21 C1).
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const REFUSED = "Only a Studio admin can change another admin's account."
const stamp = "2026-10-01T10:00:00Z"
const user = (id: string, email: string) => ({ id, email, email_confirmed_at: stamp, created_at: stamp, updated_at: stamp, user_metadata: {}, identities: [] })
const ADMIN = user("11111111-1111-1111-1111-111111111111", "owner@example.com")
const BOB = user("22222222-2222-2222-2222-222222222222", "bob@example.com")
const DEVELOPER = { sub: "dev-id", role: "developer", mode: "studio", permissions: { manageUsers: true, manageMembers: false } }

let root: Root | null = null
let container: HTMLElement

function answer(url: string, method: string): Response {
  if (url.endsWith("/studio/auth/verify")) return Response.json(DEVELOPER)
  if (url.endsWith("/studio-members")) return Response.json({ members: [{ userId: ADMIN.id, role: "admin" }] })
  if (url.endsWith("/studio-roles")) return Response.json({ roles: [] })
  if (url.endsWith("/auth/v1/settings")) return Response.json({ mailer_autoconfirm: true })
  if (url.includes("/sessions")) return Response.json({ sessions: [] })
  if (url.includes("/auth/v1/admin/users/") && method === "PUT") return Response.json({ error: REFUSED }, { status: 403 })
  if (url.includes(`/auth/v1/admin/users/${ADMIN.id}`)) return Response.json(ADMIN)
  if (url.includes("/auth/v1/admin/users")) return Response.json({ users: [ADMIN, BOB] })
  return Response.json({})
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function render(entry: string): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => answer(url, init?.method ?? "GET"))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={CLIENT}>
            <AuthManagement />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

function row(email: string): HTMLTableRowElement {
  const found = Array.from(container.querySelectorAll("tbody tr")).find((r) => r.textContent?.includes(email))
  if (!(found instanceof HTMLTableRowElement)) throw new Error(`no row for ${email}`)
  return found
}

function labels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("button")).map((b) => b.textContent ?? "")
}

function drawer(): HTMLElement {
  const panel = document.body.querySelector<HTMLElement>("[role=dialog]")
  if (!panel) throw new Error("no drawer")
  return panel
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the auth server's refusal, in its own words", () => {
  it("reads error, msg, message and error_description", () => {
    expect(authRefusalText({ error: REFUSED })).toBe(REFUSED)
    expect(authRefusalText({ msg: "User not allowed" })).toBe("User not allowed")
    expect(authRefusalText({ message: "Bad request" })).toBe("Bad request")
    expect(authRefusalText({ error: "invalid_grant", error_description: "Token expired" })).toBe("Token expired")
    expect(authRefusalText({})).toBeUndefined()
  })

  it("is what the email template editor shows, too", async () => {
    const res = Response.json({ error: REFUSED }, { status: 403 })
    expect(await refusalMessage(res, "Save")).toBe(REFUSED)
  })

  it("shows the sentence when a developer's change is refused", async () => {
    await render("/auth/users")
    const disable = Array.from(row(BOB.email).querySelectorAll("button")).find((b) => b.textContent === "Disable")
    await act(async () => disable!.click())
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")).find((b) => b.textContent === "Disable user")
    await act(async () => confirm?.click())
    await settle()
    expect(container.textContent).toContain(REFUSED)
    expect(container.textContent).not.toContain("Auth API error")
  })
})

describe("a developer looking at a Studio admin's account", () => {
  it("is not offered Disable on the admin's row, and is on anyone else's", async () => {
    await render("/auth/users")
    expect(labels(row(ADMIN.email))).not.toContain("Disable")
    expect(labels(row(BOB.email))).toContain("Disable")
  })

  it("is not offered Edit, Disable or Delete in the admin's drawer, and is told why", async () => {
    await render(`/auth/users?user=${ADMIN.id}`)
    const offered = labels(drawer())
    for (const action of ["Edit User", "Disable User", "Delete User"]) expect(offered).not.toContain(action)
    expect(drawer().textContent).toContain(REFUSED)
  })
})

describe("the users table on a phone", () => {
  // Fresh-test local21 cosmetic: at 390px the later columns (Studio access, Actions) sat off to the
  // side. On a narrow screen the secondary columns step aside and the email cell stacks the user's
  // Studio access and status under the address, so Email and Actions fit.
  const NARROW_ONLY = "md:hidden"
  const WIDE_ONLY = ["hidden", "md:table-cell"]

  it("keeps Email and Actions, and folds the rest away", async () => {
    await render("/auth/users")
    const heads = [...container.querySelectorAll("thead th")]
    const wide = heads.filter((th) => WIDE_ONLY.every((c) => th.classList.contains(c))).map((th) => th.textContent)
    expect(wide).toEqual(["Role", "Studio access", "Providers", "Confirmed", "Status", "MFA", "Last Sign-in", "Created"])
    const cells = [...row(BOB.email).querySelectorAll("td")]
    expect(cells.filter((td) => !td.classList.contains("hidden"))).toHaveLength(2)
  })

  it("stacks Studio access and status under the email", async () => {
    await render("/auth/users")
    const stacked = row(ADMIN.email).querySelector(`td [class~="${NARROW_ONLY}"]`)
    expect(stacked?.textContent).toContain("admin")
    expect(stacked?.textContent).toContain("Active")
  })
})
