// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { PoliciesView } from "../src/views/auth/PoliciesView.js"
import { StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { MigrationHistory } from "../src/views/MigrationHistory.js"
import { SeedHistory } from "../src/views/SeedHistory.js"
import { Settings } from "../src/views/Settings.js"
import { metadataBody, testClient, type MetadataBody } from "./support.js"

/**
 * RQ3b: the Policies lists, Migration History, Seed History and the Database settings read through
 * the read-only metadata route by name, so a viewer (schema view, no SQL editor) can open them.
 * The stub answers `/sql` the way both hosts answer a viewer there: refused.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

type Call = { url: string; body: MetadataBody }

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  schemas: [{ schema_name: "public" }],
  migrations_audited: [{ audited: true }],
  migrations: [{ id: 1, name: "initial_1", hash: "h".padEnd(20, "0"), applied_at: "2026-10-01 10:00:00+00", rolled_back: false, rolled_back_at: null, engine_version: "0.7.0", schema_snapshot: { models: [] }, has_sql: true }],
  migration_sql: [{ sql_up: "CREATE TABLE viewer_can_read ();" }],
  seeds: [{ id: 1, file: "seed.ts", ir_hash: "a", schema_fingerprint: "b", applied_at: "2026-10-01 10:00:00+00", duration_ms: 5, status: "committed", rows_written: {}, error_message: null, engine_version: "0.7.0" }],
  database_settings: [{ max_connections: "137", statement_timeout: "42s" }],
}

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

function stubFetch(): void {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = metadataBody(init)
    calls.push({ url, body })
    if (url.endsWith("/sql")) return Response.json({ error: "forbidden", message: "Your role cannot use the SQL editor" }, { status: 403 })
    const rows = (body.name !== undefined ? ROWS[body.name] : undefined) ?? []
    return Response.json({ rows, rowCount: rows.length })
  })
}

async function render(view: React.ReactElement, url = "/"): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function metadataCalls(): Call[] {
  return calls.filter((c) => c.url === `${PROXY}/metadata`)
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the ledger and policy views, for a viewer", () => {
  it.each([
    ["auth policies", () => <PoliciesView />, ["policies", "rls_status"]],
    ["storage policies", () => <StoragePoliciesView />, ["policies", "rls_status"]],
    ["migration history", () => <MigrationHistory />, ["migrations_audited", "migrations"]],
    ["seed history", () => <SeedHistory />, ["seeds"]],
  ] as Array<[string, () => React.ReactElement, string[]]>)("%s reads through the metadata route", async (_label, view, names) => {
    await render(view())
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
    const asked = metadataCalls().map((c) => c.body.name)
    for (const name of names) expect(asked).toContain(name)
  })

  it("binds the schema for the storage policies rather than writing it into SQL", async () => {
    await render(<StoragePoliciesView />)
    expect(metadataCalls().find((c) => c.body.name === "policies")?.body.params).toEqual({ schema: "storage" })
  })

  it("shows a migration's SQL, asked for by a bound id", async () => {
    await render(<MigrationHistory />, "/migrations?migration=1")
    await settle()
    expect(metadataCalls().find((c) => c.body.name === "migration_sql")?.body.params).toEqual({ id: "1" })
    expect(container.textContent).toContain("CREATE TABLE viewer_can_read ();")
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
  })

  it("shows the seed runs", async () => {
    await render(<SeedHistory />)
    expect(container.textContent).toContain("seed.ts")
  })

  it("shows the database settings", async () => {
    await render(<Settings />)
    const tab = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Database")
    await act(async () => tab!.click())
    await settle()
    expect(metadataCalls().map((c) => c.body.name)).toContain("database_settings")
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
    const shown = Array.from(container.querySelectorAll("input")).map((input) => input.value)
    expect(shown).toEqual(expect.arrayContaining(["137", "42s"]))
  })
})
