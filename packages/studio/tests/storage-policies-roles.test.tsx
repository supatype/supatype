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
import { RoleGate } from "../src/components/RoleGate.js"
import { STORAGE_POLICIES, StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { testClient, testConfig } from "./support.js"

/**
 * Fresh-test local21 C8: an editor was refused a bucket's Policies tab while a viewer saw its rules
 * read only, because the tab needed `schemaView`, which the role matrix gives the viewer and not the
 * editor. Owner decision: an editor reads a bucket's access rules as a viewer does, still with no
 * create, drop or RLS controls; admins and developers keep those.
 */

const raw = readFileSync(join(process.cwd(), "../cli/src/role-matrix.json"), "utf8")
const parsed: unknown = JSON.parse(raw)
const isMatrix = isShape({ permissions: isRecordOf(isArrayOf(isString)) })
if (!isMatrix(parsed)) throw new Error("role-matrix.json is not the shared role document")
const matrix = parsed

function permissionsOf(role: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(matrix.permissions).map(([name, holders]) => [name, holders.includes(role)]))
}

const POLICY = { tablename: "objects", policyname: "Images public read", cmd: "SELECT", roles: "{public}", qual: "(bucket_id = 'images'::text)", with_check: null }
const RLS = { tablename: "objects", rowsecurity: true }

let root: Root | null = null
let container: HTMLElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function render(role: string): Promise<string> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role, mode: "studio", permissions: permissionsOf(role) })
    const name = String(init?.body ?? "").includes("rls_status") ? "rls" : "policies"
    return Response.json({ rows: name === "rls" ? [RLS] : [POLICY], rowCount: 1 })
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const page = <RoleGate {...STORAGE_POLICIES}><StoragePoliciesView /></RoleGate>
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/media-storage/images/policies"]}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <Routes><Route path="media-storage/:bucket/policies" element={page} /></Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return container.textContent ?? ""
}

const controls = (): string[] =>
  [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter((t) => /^(Create policy|Drop|Enable RLS|Disable RLS)$/.test(t))

describe("a bucket's Policies tab", () => {
  it.each(["editor", "viewer"])("shows %s the rules read only", async (role) => {
    const text = await render(role)
    expect(text).not.toContain("can't view access policies")
    expect(text).toContain("Images public read")
    expect(controls()).toEqual([])
  })

  it.each(["admin", "developer"])("gives %s the controls", async (role) => {
    const text = await render(role)
    expect(text).toContain("Images public read")
    expect(controls()).toContain("Create policy")
  })
})
