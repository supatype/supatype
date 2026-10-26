// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { ExtensionsView } from "../src/views/database/ExtensionsView.js"
import { PoliciesView as AuthPoliciesView } from "../src/views/auth/PoliciesView.js"
import { StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { asking, press } from "./dialog-support.js"
import { act, elementOf, isolateEachTest, metadataBody, mount, settle, testClient } from "./support.js"

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

async function render(view: React.ReactElement, rows: Catalogue): Promise<void> {
  stubFetch(rows)
  await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
}

/** Disables RLS and answers yes to the question that follows. */
async function disableRls(): Promise<void> {
  await press("Disable RLS")
  await press("Disable RLS", elementOf(document.body, "[role=alertdialog]", HTMLElement))
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
  // Any browser confirm() is a failure: a question is asked in Studio's own dialog, which a test
  // answers by clicking, so a stray confirm() would have to be answered here to pass.
  vi.stubGlobal("confirm", () => { throw new Error("window.confirm was called") })
})

isolateEachTest()

describe("Extensions write through /studio-admin/extensions", () => {
  it("enables an available extension", async () => {
    await render(<ExtensionsView />, catalogue("public", "t"))
    await press("Enable")
    expect(writes()).toEqual([{ path: "/studio-admin/extensions", body: { name: "hstore", enable: true } }])
  })

  it("asks, then disables an installed extension", async () => {
    await render(<ExtensionsView />, catalogue("public", "t"))
    await press("Disable")
    expect(asking()).toContain("Disable pgcrypto?")
    expect(writes()).toEqual([])
    await press("Disable extension")
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

  it("asks, then drops a policy through /studio-admin/policies", async () => {
    await render(view(), catalogue(schema, table))
    await press("Drop")
    expect(asking()).toContain(`Drop policy owner_read on ${schema}.${table}?`)
    expect(writes()).toEqual([])
    await press("Drop policy")
    expect(writes()).toEqual([{ path: "/studio-admin/policies", body: { schema, table, op: "drop", name: "owner_read" } }])
  })

  it("creates a policy from the structured form", async () => {
    await render(view(), catalogue(schema, table))
    await press("Create policy")
    await press("I understand, continue")
    await fill("Table", table)
    await fill("Policy name", "self_update")
    await fill("Command", "UPDATE")
    await fill("Roles", "authenticated, service_role")
    await fill("USING", "auth.uid() = id")
    await fill("WITH CHECK", "auth.uid() = id")
    await press("Save policy")
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
  it("drafts the drop as SQL, and asks before running it", async () => {
    await render(<AuthPoliciesView />, catalogue("public", "todos"))
    await press("Drop")
    expect(document.body.querySelector("textarea")?.value).toBe('DROP POLICY "owner_read" ON "public"."todos";')
    await press("Run SQL")
    expect(asking()).toContain("Run this SQL on public?")
    expect(writes()).toEqual([])
    await press("Run on public")
    expect(writes()).toEqual([{ path: "/sql", body: { query: 'DROP POLICY "owner_read" ON "public"."todos";', schema: "public" } }])
  })

  it("runs nothing when the question is cancelled", async () => {
    await render(<AuthPoliciesView />, catalogue("public", "todos"))
    await press("Drop")
    await press("Run SQL")
    await press("Cancel", elementOf(document.body, '[role="alertdialog"]', HTMLElement))
    expect(asking()).toBeNull()
    expect(writes()).toEqual([])
  })

  it("runs a drafted new policy straight after review: creating is not destructive", async () => {
    await render(<AuthPoliciesView />, catalogue("public", "todos"))
    await press("Create policy")
    await press("I understand, continue")
    expect(document.body.querySelector("textarea")?.value).toMatch(/^CREATE POLICY my_policy ON "public".my_table/)
    await press("Run SQL")
    expect(asking()).toBeNull()
    expect(writes().map((c) => c.path)).toEqual(["/sql"])
  })

  it("still switches RLS through the SQL editor's route", async () => {
    await render(<AuthPoliciesView />, catalogue("public", "todos"))
    await disableRls()
    expect(writes().map((c) => c.path)).toEqual(["/sql"])
  })
})
