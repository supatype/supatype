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
 * Deleting a user from the drawer asks with the shared Dialog, as every other delete in Studio does.
 *
 * The drawer had its own inline "This is irreversible. / Confirm Delete" (final15). The question is
 * now the alertdialog the list and record deletes use, and the auth server's refusal to delete the
 * last Studio admin is still said in the drawer.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const ADA = { id: "11111111-1111-1111-1111-111111111111", email: "ada@example.com", email_confirmed_at: "2026-10-01T10:00:00Z", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", user_metadata: {}, identities: [] }
const LAST_ADMIN = "this is the last Studio admin; promote someone else to admin first"

let root: Root | null = null
let container: HTMLElement
let deletes: string[] = []

function answer(url: string, method: string, refuse: boolean): Response {
  if (url.endsWith("/studio/auth/verify")) return Response.json({ sub: "admin-id", role: "admin", mode: "self", permissions: { manageMembers: true } })
  if (url.endsWith("/auth/v1/settings")) return Response.json({ mailer_autoconfirm: true })
  if (url.includes("/sessions")) return Response.json({ sessions: [] })
  if (url.includes(`/auth/v1/admin/users/${ADA.id}`) && method === "DELETE") {
    deletes.push(url)
    return refuse ? Response.json({ code: 409, error_code: "conflict", msg: LAST_ADMIN }, { status: 409 }) : Response.json({})
  }
  if (url.includes("/auth/v1/admin/users/")) return Response.json(ADA)
  if (url.includes("/auth/v1/admin/users")) return Response.json({ users: [ADA], aud: "authenticated" })
  return Response.json({ rows: [], members: [], roles: [] })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function openAda(refuse: boolean): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  deletes = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => answer(url, init?.method ?? "GET", refuse))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/auth/users?user=${ADA.id}`]}>
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

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label)
  if (!found) throw new Error(`no ${label} button`)
  return found
}

/** The slide panel renders into a portal, outside the view's container. */
function drawer(): HTMLElement {
  const panel = document.body.querySelector<HTMLElement>("[role=dialog]")
  if (!panel) throw new Error("no drawer")
  return panel
}

/** Presses Delete User and answers the question with `label`. */
async function deleteAda(label: "Delete" | "Cancel"): Promise<void> {
  await act(async () => button(drawer(), "Delete User").click())
  const question = document.body.querySelector<HTMLElement>("[role=alertdialog]")
  if (!question) throw new Error("no confirmation dialog")
  expect(question.getAttribute("aria-label")).toBe(`Delete "${ADA.email}"?`)
  await act(async () => button(question, label).click())
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("deleting a user from the drawer", () => {
  it("asks with the shared dialog, not an inline Confirm Delete", async () => {
    await openAda(false)
    await deleteAda("Cancel")
    expect(drawer().textContent).not.toContain("Confirm Delete")
    expect(document.body.querySelector("[role=alertdialog]")).toBeNull()
    expect(deletes).toHaveLength(0)
  })

  it("deletes once the question is answered", async () => {
    await openAda(false)
    await deleteAda("Delete")
    expect(deletes).toHaveLength(1)
  })

  it("keeps the drawer open with the refusal to delete the last admin", async () => {
    await openAda(true)
    await deleteAda("Delete")
    expect(deletes).toHaveLength(1)
    expect(drawer().textContent).toContain(LAST_ADMIN)
  })

  it("says the refusal right above the actions, where the button was pressed", async () => {
    // Live on kitchen-sink the drawer lists every session, so a refusal at its top was scrolled out
    // of sight of the Delete User button at its bottom.
    await openAda(true)
    await deleteAda("Delete")
    const actions = button(drawer(), "Delete User").closest("[data-user-actions]")
    expect(actions?.previousElementSibling?.textContent).toContain(LAST_ADMIN)
    expect(drawer().textContent?.split(LAST_ADMIN)).toHaveLength(2)
  })
})
