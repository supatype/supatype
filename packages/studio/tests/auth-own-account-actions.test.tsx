// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { testClient } from "./support.js"

/**
 * Fresh-user test 3: a developer still had Disable on their own row in Users. The Studio roles page
 * says nobody can change their own Studio role or remove their own access, so the signed-in user's
 * own account offers no Disable, no Delete and no Studio role change, in the row or the drawer.
 * Editing their own details stays.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const stamp = "2026-10-01T10:00:00Z"
const user = (id: string, email: string) => ({ id, email, email_confirmed_at: stamp, created_at: stamp, updated_at: stamp, user_metadata: {}, identities: [] })
const ME = user("33333333-3333-3333-3333-333333333333", "me@example.com")
const BOB = user("22222222-2222-2222-2222-222222222222", "bob@example.com")

let root: Root | null = null
let container: HTMLElement

function answer(url: string, verify: Record<string, unknown>): Response {
  if (url.endsWith("/studio/auth/verify")) return Response.json(verify)
  if (url.endsWith("/studio-members")) return Response.json({ members: [{ userId: ME.id, role: String(verify["role"]) }] })
  if (url.endsWith("/studio-roles")) return Response.json({ roles: [{ role: "admin" }, { role: "developer" }] })
  if (url.endsWith("/auth/v1/settings")) return Response.json({ mailer_autoconfirm: true })
  if (url.includes("/sessions")) return Response.json({ sessions: [] })
  if (url.includes(`/auth/v1/admin/users/${ME.id}`)) return Response.json(ME)
  if (url.includes("/auth/v1/admin/users")) return Response.json({ users: [ME, BOB] })
  return Response.json({})
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function render(entry: string, role: "developer" | "admin"): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const verify = { sub: ME.id, role, mode: "studio", permissions: { manageUsers: true, manageMembers: role === "admin" } }
  vi.stubGlobal("fetch", async (url: string) => answer(url, verify))
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

const labels = (scope: ParentNode): string[] => Array.from(scope.querySelectorAll("button")).map((b) => b.textContent ?? "")

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

describe.each(["developer", "admin"] as const)("a %s looking at their own account", (role) => {
  it("is not offered Disable on their own row, and is on anyone else's", async () => {
    await render("/auth/users", role)
    expect(labels(row(ME.email))).not.toContain("Disable")
    expect(labels(row(BOB.email))).toContain("Disable")
  })

  it("is offered Edit but not Disable or Delete in their own drawer", async () => {
    await render(`/auth/users?user=${ME.id}`, role)
    const offered = labels(drawer())
    expect(offered).toContain("Edit User")
    for (const action of ["Disable User", "Delete User"]) expect(offered).not.toContain(action)
  })

  it("cannot change their own Studio role", async () => {
    await render("/auth/users", role)
    expect(row(ME.email).querySelector("select")).toBeNull()
  })
})
