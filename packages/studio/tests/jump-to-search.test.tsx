// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { JumpToSearch } from "../src/components/JumpToSearch.js"
import { testClient, testConfig, testModel } from "./support.js"

/**
 * Jump to searches users and records on the server and loads more of either on request. It used
 * to read the first 200 users and filter those in the browser, search only the first five models,
 * and show at most five records of each, so anything past those could not be reached from it.
 *
 * The user stub answers like the auth server (one based `page`, `per_page`, `filter`,
 * X-Total-Count); the record stub like PostgREST (`limit`, `offset`, Content-Range with
 * `Prefer: count=exact`).
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const USERS = Array.from({ length: 62 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  email: `user${i + 1}@example.com`,
  user_metadata: {},
}))
const LATE = USERS[59]!
const MODELS = Array.from({ length: 6 }, (_, i) =>
  testModel({ name: `thing${i + 1}`, label: `Thing ${i + 1}`, labelPlural: `Things ${i + 1}`, tableName: `things${i + 1}`, searchFields: ["name"] }),
)
const RECORDS = Array.from({ length: 12 }, (_, i) => ({ id: `r${i + 1}`, name: `user record ${i + 1}` }))

let root: Root | null = null
let container: HTMLElement
let calls: URL[] = []

function userList(url: URL): Response {
  const page = Number(url.searchParams.get("page") ?? "1")
  const perPage = Number(url.searchParams.get("per_page") ?? "50")
  const matching = USERS.filter((u) => u.email.includes(url.searchParams.get("filter") ?? ""))
  const users = matching.slice((page - 1) * perPage, page * perPage)
  return Response.json({ users, aud: "authenticated" }, { headers: { "X-Total-Count": String(matching.length) } })
}

function userById(id: string): Response {
  const user = USERS.find((u) => u.id === id)
  return user ? Response.json(user) : Response.json({ msg: "User not found" }, { status: 404 })
}

/** Only `things6`, the model the old code never searched, holds records. */
function records(url: URL): Response {
  const rows = url.pathname.endsWith("/things6") ? RECORDS : []
  const offset = Number(url.searchParams.get("offset") ?? "0")
  const page = rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? "1000"))
  const range = page.length > 0 ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}`
  return Response.json(page, { headers: { "Content-Range": range } })
}

function route(url: URL): Response {
  const byId = /\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)
  if (byId) return userById(byId[1]!)
  if (url.pathname.endsWith("/auth/v1/admin/users")) return userList(url)
  if (url.pathname.includes("/rest/v1/")) return records(url)
  return Response.json({})
}

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    calls.push(url)
    return route(url)
  })
}

function Where(): React.ReactElement {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }
}

async function renderJump(): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <AdminConfigContext.Provider value={testConfig({ models: MODELS })}>
          <AdminClientContext.Provider value={CLIENT}>
            <JumpToSearch />
            <Where />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function type(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input[type=text]")
  if (!input) throw new Error("no Jump to input")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    input.focus()
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  // Past the debounce, then let the requests land.
  await settle(150)
}

function rows(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) => b.textContent !== "")
}

function row(text: string): HTMLButtonElement | undefined {
  return rows().find((b) => b.textContent?.includes(text))
}

async function press(button: HTMLButtonElement | undefined): Promise<void> {
  if (!button) throw new Error("no such row")
  await act(async () => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
  })
  await settle()
}

function userCalls(): URL[] {
  return calls.filter((u) => u.pathname.endsWith("/auth/v1/admin/users"))
}

function userRows(): number {
  return rows().filter((b) => /user\d+@example\.com/.test(b.textContent ?? "")).length
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("Jump to", () => {
  it("searches users on the server with the typed text", async () => {
    await renderJump()
    await type("User60@")
    const last = userCalls().at(-1)
    expect(last?.searchParams.get("filter")).toBe("user60@")
    expect(row(LATE.email)).toBeDefined()
  })

  it("opens the user that was clicked", async () => {
    await renderJump()
    await type("user60@")
    await press(row(LATE.email))
    expect(container.querySelector("[data-testid=where]")?.textContent).toBe(`/authentication/users?user=${LATE.id}`)
  })

  it("loads more users on request, the next page from the server", async () => {
    await renderJump()
    await type("user")
    expect(userRows()).toBe(5)
    await press(row("More users"))
    expect(userCalls().at(-1)?.searchParams.get("page")).toBe("2")
    expect(userRows()).toBe(10)
  })

  it("finds a user by ID", async () => {
    await renderJump()
    await type(LATE.id)
    expect(calls.some((u) => u.pathname.endsWith(`/admin/users/${LATE.id}`))).toBe(true)
    expect(row(LATE.email)).toBeDefined()
  })

  it("searches every model, not only the first five", async () => {
    await renderJump()
    await type("user record")
    expect(calls.some((u) => u.pathname.endsWith("/rest/v1/things6"))).toBe(true)
    expect(row("user record 1")).toBeDefined()
  })

  // Page links stopped at the first five matches, with no way to the rest.
  it("shows more page links on request", async () => {
    await renderJump()
    await type("database")
    const pageRows = () => rows().filter((b) => b.textContent?.endsWith("Database") && !b.textContent.startsWith("More")).length
    expect(pageRows()).toBe(5)
    await press(row("More pages"))
    expect(pageRows()).toBe(10)
  })

  it("searches records with the typed text read literally", async () => {
    await renderJump()
    await type("a,b)")
    const last = calls.filter((u) => u.pathname.endsWith("/rest/v1/things1")).at(-1)
    expect(last?.searchParams.get("or")).toBe('(name.ilike."%a,b)%")')
  })

  it("loads more records on request, from the next offset", async () => {
    await renderJump()
    await type("user record")
    await press(row("More Things 6"))
    const last = calls.filter((u) => u.pathname.endsWith("/rest/v1/things6")).at(-1)
    expect(last?.searchParams.get("offset")).toBe("5")
    expect(row("user record 10")).toBeDefined()
  })
})
