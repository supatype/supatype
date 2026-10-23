// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { RelationWidget } from "../src/widgets/RelationWidget.js"
import type { FieldConfig } from "../src/config.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * The relation picker searches on the server and loads more options on request. Its user picker
 * used to read the first 200 users and filter them in the browser, so an older user could not be
 * picked even by their exact email, and both pickers stopped at their first 30 options.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const USERS = Array.from({ length: 250 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  email: `user${i + 1}@example.com`,
  user_metadata: {},
}))
const OLDEST = USERS[239]!
const THINGS = Array.from({ length: 45 }, (_, i) => ({ id: `t${i + 1}`, name: `thing ${i + 1}` }))

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

function things(url: URL): Response {
  const offset = Number(url.searchParams.get("offset") ?? "0")
  return Response.json(THINGS.slice(offset, offset + Number(url.searchParams.get("limit") ?? "1000")))
}

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    calls.push(url)
    if (url.pathname.endsWith("/auth/v1/admin/users")) return userList(url)
    if (url.pathname.endsWith("/rest/v1/things") || url.pathname.endsWith("/rest/v1/loose")) return things(url)
    return Response.json({})
  })
}

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }
}

/** `things` is a model keyed on `code`; `loose` is a table no model describes. */
const CONFIG = testConfig({ models: [testModel({ name: "thing", tableName: "things", primaryKey: "code" })] })

async function openPicker(field: FieldConfig): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={CONFIG}>
          <AdminClientContext.Provider value={CLIENT}>
            <RelationWidget config={field} value={null} onChange={() => undefined} readOnly={false} />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await act(async () => container.querySelector<HTMLElement>("[role=combobox]")?.click())
  await settle()
}

async function search(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input[type=search]")
  if (!input) throw new Error("no picker search box")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle(100)
}

function options(): string[] {
  // Each option is named by its label (aria-labelledby), so this reads what a screen reader says.
  return Array.from(container.querySelectorAll("[role=option]")).map((o) => document.getElementById(o.getAttribute("aria-labelledby") ?? "")?.textContent ?? "")
}

async function loadMore(): Promise<void> {
  const more = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Load more")
  if (!more) throw new Error("no Load more row")
  await act(async () => more.click())
  await settle()
}

const userField = testField({ name: "owner", label: "Owner", widget: "relation", options: { target: "supatype:user" } })
const thingField = testField({ name: "thing", label: "Thing", widget: "relation", options: { target: "things", displayField: "name" } })

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the relation picker", () => {
  it("finds a user past the first 200 by searching on the server", async () => {
    await openPicker(userField)
    await search(OLDEST.email)
    expect(calls.at(-1)?.searchParams.get("filter")).toBe(OLDEST.email)
    expect(options()).toEqual([OLDEST.email])
  })

  it("loads the next page of users on request", async () => {
    await openPicker(userField)
    expect(options()).toHaveLength(30)
    await loadMore()
    expect(calls.at(-1)?.searchParams.get("page")).toBe("2")
    expect(options()).toHaveLength(60)
  })

  // Paged by offset, so the order must not shift between pages: unordered, Postgres may answer the
  // same rows on two pages and skip others.
  it("pages records in the order of the target model's primary key", async () => {
    await openPicker(thingField)
    expect(calls.at(-1)?.searchParams.get("order")).toBe("code.asc")
  })

  it("pages a table no model describes in its physical order", async () => {
    await openPicker(testField({ name: "loose", label: "Loose", widget: "relation", options: { target: "loose", displayField: "name" } }))
    expect(calls.at(-1)?.searchParams.get("order")).toBe("ctid.asc")
  })

  it("searches records with the typed text read literally", async () => {
    await openPicker(thingField)
    await search("50%")
    expect(calls.at(-1)?.searchParams.get("name")).toBe(String.raw`ilike.%50\%%`)
  })

  it("loads the next page of records on request", async () => {
    await openPicker(thingField)
    expect(options()).toHaveLength(30)
    await loadMore()
    expect(calls.at(-1)?.searchParams.get("offset")).toBe("30")
    expect(options()).toHaveLength(45)
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Load more")).toBe(false)
  })
})
