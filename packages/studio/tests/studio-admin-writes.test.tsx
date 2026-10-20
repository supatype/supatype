// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { ExtensionsView } from "../src/views/database/ExtensionsView.js"
import { PoliciesView as AuthPoliciesView } from "../src/views/auth/PoliciesView.js"
import { StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { metadataBody, testClient } from "./support.js"

/**
 * SQ2: the SQL editor's login is not a superuser, so Studio's extension, RLS and auth/storage
 * policy writes go through the allow-listed `/studio-admin/*` routes, never through `/sql`.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

interface Call {
  path: string
  body: unknown
}

/** The rows each catalogue query answers with, per schema the view reads. */
type Catalogue = Record<string, Array<Record<string, unknown>>>

function catalogue(schema: string, table: string): Catalogue {
  return {
    schemas: [{ schema_name: schema }],
    extensions_installed: [{ extname: "pgcrypto", extversion: "1", description: null }],
    extensions_available: [{ name: "hstore", default_version: "1", comment: null }],
    policies: [{ tablename: table, policyname: "owner_read", cmd: "SELECT", permissive: "PERMISSIVE", qual: "true", with_check: null }],
    rls_status: [{ tablename: table, rls_enabled: true }],
  }
}

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

function stubFetch(rows: Catalogue): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = url.slice(PROXY.length)
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role: "developer", mode: "self", canElevate: false, permissions: { sqlEditor: true, schemaView: true } })
    }
    calls.push({ path, body })
    if (path.startsWith("/metadata")) {
      const found = rows[metadataBody(init).name ?? ""] ?? []
      return Response.json({ rows: found, rowCount: found.length })
    }
    if (path.startsWith("/studio-admin/")) return Response.json({ ok: true })
    return Response.json({ rows: [], rowCount: 0 })
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(view: React.ReactElement, rows: Catalogue): Promise<void> {
  stubFetch(rows)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function click(label: string, scope: ParentNode = document.body): Promise<void> {
  const button = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label)
  if (!button) throw new Error(`no button "${label}"`)
  await act(async () => { button.click() })
  await settle()
}

/** Disables RLS and answers yes to the question that follows. */
async function disableRls(): Promise<void> {
  await click("Disable RLS")
  const asking = document.body.querySelector("[role=alertdialog]")
  if (!asking) throw new Error("Disable RLS did not ask")
  await click("Disable RLS", asking)
}

/** Types into the control labelled `label`, as a person would. */
async function fill(label: string, value: string): Promise<void> {
  const el = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)
  if (!el) throw new Error(`no control "${label}"`)
  // React tracks the value through the element type's own setter, so the write has to go through it.
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
  })
}

/** The writes the view sent, which are every call that was not a catalogue read. */
function writes(): Call[] {
  return calls.filter((c) => !c.path.startsWith("/metadata"))
}

beforeEach(() => {
  calls = []
  vi.stubGlobal("confirm", () => true)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("Extensions write through /studio-admin/extensions", () => {
  it("enables an available extension", async () => {
    await render(<ExtensionsView />, catalogue("public", "t"))
    await click("Enable")
    expect(writes()).toEqual([{ path: "/studio-admin/extensions", body: { name: "hstore", enable: true } }])
  })

  it("disables an installed extension", async () => {
    await render(<ExtensionsView />, catalogue("public", "t"))
    await click("Disable")
    expect(writes()).toEqual([{ path: "/studio-admin/extensions", body: { name: "pgcrypto", enable: false } }])
  })
})

const POLICY_VIEWS: Array<[string, () => React.ReactElement, "auth" | "storage", string]> = [
  ["Auth policies", () => <AuthPoliciesView />, "auth", "users"],
  ["Storage policies", () => <StoragePoliciesView />, "storage", "objects"],
]

describe.each(POLICY_VIEWS)("%s write through /studio-admin", (_label, view, schema, table) => {
  it("switches RLS through /studio-admin/rls", async () => {
    await render(view(), catalogue(schema, table))
    await disableRls()
    expect(writes()).toEqual([{ path: "/studio-admin/rls", body: { schema, table, enable: false } }])
  })

  it("drops a policy through /studio-admin/policies", async () => {
    await render(view(), catalogue(schema, table))
    await click("Drop")
    expect(writes()).toEqual([{ path: "/studio-admin/policies", body: { schema, table, op: "drop", name: "owner_read" } }])
  })

  it("creates a policy from the structured form", async () => {
    await render(view(), catalogue(schema, table))
    await click("Create policy")
    await click("I understand, continue")
    await fill("Table", table)
    await fill("Policy name", "self_update")
    await fill("Command", "UPDATE")
    await fill("Roles", "authenticated, service_role")
    await fill("USING", "auth.uid() = id")
    await fill("WITH CHECK", "auth.uid() = id")
    await click("Save policy")
    expect(writes()).toEqual([{
      path: "/studio-admin/policies",
      body: {
        schema, table, op: "create", name: "self_update", command: "UPDATE",
        roles: ["authenticated", "service_role"], using: "auth.uid() = id", check: "auth.uid() = id",
      },
    }])
  })
})

describe("Auth policies on a schema the admin routes do not cover", () => {
  it("still switches RLS through the SQL editor's route", async () => {
    await render(<AuthPoliciesView />, catalogue("public", "todos"))
    await disableRls()
    expect(writes().map((c) => c.path)).toEqual(["/sql"])
  })
})
