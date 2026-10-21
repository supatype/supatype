// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { act, button, elementOf, findButton, isolateEachTest, mount, settle, testClient, unmount, type Mounted } from "./support.js"

/**
 * AU1: the auth server confirms a user created through its admin API only when the request says
 * `email_confirm: true`. Project auto-confirm covers public sign-ups, not admin creation, so users
 * added in Studio stayed unconfirmed while the Configuration page said confirmation was not
 * required. The create form now says whether to confirm, defaulting to the project's own setting,
 * and an unconfirmed user can be confirmed afterwards by whoever may administer users.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
/** A user as the auth admin API answers it, trimmed to what the view reads. */
interface RawUser {
  id: string
  email: string
  email_confirmed_at: string | null
  created_at: string
  updated_at: string
  user_metadata: Record<string, unknown>
  identities: never[]
}

const CONFIRMED: RawUser = { id: "11111111-1111-1111-1111-111111111111", email: "ada@example.com", email_confirmed_at: "2026-10-01T10:00:00Z", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z", user_metadata: {}, identities: [] }
const PENDING: RawUser = { ...CONFIRMED, id: "33333333-3333-3333-3333-333333333333", email: "grace@example.com", email_confirmed_at: null }

interface Call { url: string; method: string; body: unknown }
interface Scenario {
  /** What `GET /auth/v1/settings` reports for `mailer_autoconfirm`. */
  autoconfirm: boolean
  /** Whether the caller's Studio role carries `manageUsers`, which gates the auth admin API. */
  manageUsers: boolean
  /** The user whose detail panel opens, if any. */
  open?: RawUser
  /** Whether the auth server refuses the confirmation PUT. */
  refuseConfirm?: boolean
  /** Whether the auth server refuses the invitation, as it does for an address already registered. */
  refuseInvite?: boolean
}

/** What one test's auth server has been sent, and what it holds. */
interface Server {
  calls: Call[]
  /** The referrer policy each request was sent with, in the order of `calls`. */
  referrerPolicies: Array<RequestInit["referrerPolicy"]>
  /** What the auth server holds for PENDING's confirmation, so a refetch sees the PUT's effect. */
  pendingConfirmedAt: string | null
}

/** The Users view on screen, and the server behind it. */
interface Users {
  server: Server
  view: Mounted
}

isolateEachTest()

function pending(server: Server): RawUser {
  return { ...PENDING, email_confirmed_at: server.pendingConfirmedAt }
}

function answer(url: string, method: string, s: Scenario, server: Server): Response {
  if (url.endsWith("/studio/auth/verify")) {
    return Response.json({ sub: "admin-id", role: s.manageUsers ? "admin" : "editor", mode: "self", permissions: { manageUsers: s.manageUsers } })
  }
  if (url.endsWith("/auth/v1/settings")) return Response.json({ mailer_autoconfirm: s.autoconfirm })
  if (url.endsWith("/auth/v1/admin/sessions")) return Response.json({ sessions: [] })
  if (url.endsWith("/auth/v1/invite") && method === "POST") {
    if (s.refuseInvite === true) return Response.json({ msg: "A user with this email address has already been registered" }, { status: 422 })
    return Response.json({ ...PENDING, id: "55555555-5555-5555-5555-555555555555", email: "invited@example.com" })
  }
  if (url.endsWith("/auth/v1/admin/users") && method === "POST") return Response.json({ ...PENDING, id: "44444444-4444-4444-4444-444444444444" })
  if (url.includes(`/auth/v1/admin/users/${PENDING.id}`) && method === "PUT") {
    if (s.refuseConfirm === true) return Response.json({ msg: "User not allowed" }, { status: 403 })
    server.pendingConfirmedAt = "2026-10-15T10:00:00Z"
    return Response.json(pending(server))
  }
  if (url.includes("/auth/v1/admin/users/")) return Response.json(url.includes(PENDING.id) ? pending(server) : CONFIRMED)
  if (url.includes("/auth/v1/admin/users")) return Response.json({ users: [CONFIRMED, pending(server)], aud: "authenticated" })
  return Response.json({ rows: [], members: [], roles: [] })
}

function stubFetch(s: Scenario): Server {
  const server: Server = { calls: [], referrerPolicies: [], pendingConfirmedAt: null }
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    server.calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    server.referrerPolicies.push(init?.referrerPolicy)
    return answer(url, method, s, server)
  })
  return server
}

async function renderUsers(s: Scenario): Promise<Users> {
  const server = stubFetch(s)
  const entry = s.open ? `/auth/users?user=${s.open.id}` : "/auth/users"
  const view = await mount(
    <MemoryRouter initialEntries={[entry]}>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>
          <AuthManagement />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { server, view }
}

/** The slide panel renders into a portal, outside the view's container. */
function panel(): HTMLElement {
  const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")
  if (!dialog) throw new Error("no slide panel rendered")
  return dialog
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

/** The Users view with its create form open, and the form's Auto-confirm email checkbox. */
interface CreateForm {
  users: Users
  checkbox: HTMLInputElement
}

async function openCreateForm(s: Scenario): Promise<CreateForm> {
  const users = await renderUsers(s)
  await act(async () => button(users.view.container, "+ Create User").click())
  await settle()
  // An Auto-confirm email checkbox from the shared Checkbox primitive.
  const checkbox = elementOf(panel(), "input[data-ui=checkbox]", HTMLInputElement)
  expect(panel().textContent).toContain("Auto-confirm email")
  return { users, checkbox }
}

async function submitCreateForm({ calls }: Server): Promise<unknown> {
  const email = elementOf(panel(), "input[data-ui=input]", HTMLInputElement)
  const password = elementOf(panel(), "input[type=password]", HTMLInputElement)
  await act(() => {
    type(email, "new@example.com")
    type(password, "a-long-password")
  })
  await act(async () => button(panel(), "Create User").click())
  await settle()
  return calls.find((c) => c.method === "POST" && c.url === `${PROXY}/auth/v1/admin/users`)?.body
}

describe("creating a user in Studio", () => {
  it("ticks Auto-confirm email by default when the project auto-confirms, and sends email_confirm: true", async () => {
    const { users, checkbox } = await openCreateForm({ autoconfirm: true, manageUsers: true })
    expect(checkbox.checked).toBe(true)
    expect(await submitCreateForm(users.server)).toMatchObject({ email: "new@example.com", email_confirm: true })
  })

  it("leaves it unticked when the project requires confirmation, and sends email_confirm: false", async () => {
    const { users, checkbox } = await openCreateForm({ autoconfirm: false, manageUsers: true })
    expect(checkbox.checked).toBe(false)
    expect(await submitCreateForm(users.server)).toMatchObject({ email: "new@example.com", email_confirm: false })
  })

  it("sends what the checkbox says once it is changed, either way", async () => {
    const first = await openCreateForm({ autoconfirm: true, manageUsers: true })
    await act(async () => first.checkbox.click())
    expect(await submitCreateForm(first.users.server)).toMatchObject({ email_confirm: false })
    unmount(first.users.view)

    const second = await openCreateForm({ autoconfirm: false, manageUsers: true })
    await act(async () => second.checkbox.click())
    expect(await submitCreateForm(second.users.server)).toMatchObject({ email_confirm: true })
  })
})

describe("confirming an existing user's email", () => {
  it("confirms an unconfirmed user through the auth admin API, then refetches", async () => {
    const { server: { calls } } = await renderUsers({ autoconfirm: false, manageUsers: true, open: PENDING })
    const confirm = button(panel(), "Confirm email")
    const listReads = calls.filter((c) => c.method === "GET" && c.url.includes("/auth/v1/admin/users?")).length
    await act(() => confirm.click())
    await settle()
    expect(calls).toContainEqual({ url: `${PROXY}/auth/v1/admin/users/${PENDING.id}`, method: "PUT", body: { email_confirm: true } })
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/auth/v1/admin/users?")).length).toBeGreaterThan(listReads)
    expect(findButton(panel(), "Confirm email"), "gone once the user is confirmed").toBeUndefined()
  })

  it("shows the auth server's refusal instead of dropping it", async () => {
    await renderUsers({ autoconfirm: false, manageUsers: true, open: PENDING, refuseConfirm: true })
    await act(async () => button(panel(), "Confirm email").click())
    await settle()
    expect(panel().textContent).toContain("User not allowed")
    expect(findButton(panel(), "Confirm email"), "still offered, since nothing changed").toBeDefined()
  })

  it("is not offered for a user who is already confirmed", async () => {
    await renderUsers({ autoconfirm: false, manageUsers: true, open: CONFIRMED })
    expect(panel().textContent).toContain("Edit User")
    expect(findButton(panel(), "Confirm email")).toBeUndefined()
  })

  it("is not offered to a Studio role that may not administer users", async () => {
    await renderUsers({ autoconfirm: false, manageUsers: false, open: PENDING })
    expect(panel().textContent).toContain("Edit User")
    expect(findButton(panel(), "Confirm email")).toBeUndefined()
  })
})

// IMP1: the panel offered "Impersonate" and then printed a made-up JWT as if one had been minted.
// Nothing was minted, and showing a real token would hand out the user's credential. Until Studio
// can run its own editors as a user, the panel offers no impersonation at all.
describe("impersonating a user", () => {
  it("is not offered", async () => {
    await renderUsers({ autoconfirm: false, manageUsers: true, open: CONFIRMED })
    expect(panel().textContent).toContain("Edit User")
    expect(findButton(panel(), "Impersonate")).toBeUndefined()
  })
})

// EM2: "Invite User" promised an invitation email but created the user through the admin users
// API, which sends nothing, so the invited person had no way to sign in. It now goes through the
// auth server's invite endpoint, which creates the user and mails them the invitation link.
describe("inviting a user", () => {
  async function invite(s: Scenario): Promise<Server> {
    const users = await renderUsers(s)
    await act(async () => button(users.view.container, "Invite User").click())
    await settle()
    const email = elementOf(panel(), "input[data-ui=input]", HTMLInputElement)
    await act(() => type(email, "invited@example.com"))
    await act(async () => button(panel(), "Send Invite").click())
    await settle()
    return users.server
  }

  it("asks the auth server to send the invitation, and creates no user directly", async () => {
    const { calls } = await invite({ autoconfirm: false, manageUsers: true })
    expect(calls).toContainEqual({ url: `${PROXY}/auth/v1/invite`, method: "POST", body: { email: "invited@example.com" } })
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/auth/v1/admin/users"))).toBeUndefined()
    expect(findButton(panel(), "Send Invite"), "the form closes once the invitation is sent").toBeUndefined()
  })

  // The auth server takes a request's Referer as the emailed link's redirect when it names none, so
  // the invitation landed the invitee on this Studio page ("Access denied") instead of the app.
  it("sends no Referer, so the invitation link lands on the project's site URL", async () => {
    const { calls, referrerPolicies } = await invite({ autoconfirm: false, manageUsers: true })
    const at = calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/auth/v1/invite"))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(referrerPolicies[at]).toBe("no-referrer")
  })

  it("shows the auth server's refusal and keeps the form open", async () => {
    await invite({ autoconfirm: false, manageUsers: true, refuseInvite: true })
    expect(panel().textContent).toContain("A user with this email address has already been registered")
    expect(findButton(panel(), "Send Invite")).toBeDefined()
  })
})
