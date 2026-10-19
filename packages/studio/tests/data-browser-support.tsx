import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { DataExplorer } from "../src/views/DataExplorer.js"
import { testClient, testConfig } from "./support.js"

/**
 * Database > Tables > Browse data on realtime's `message` table: 30 rows that Postgres last
 * sampled at 18. The REST stub answers like PostgREST: a range of rows, with Content-Range carrying
 * the total only when a count was asked for, and every insert body recorded.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const ROWS = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, body: `message ${i + 1}`, created_at: "2026-10-19T10:00:00+00:00" }))

function column(name: string, udt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    table_name: "message", table_schema: "public", column_name: name, udt_name: udt, is_nullable: "NO",
    column_default: null, is_primary: false, is_foreign_key: false, references_col: null, is_unique: false, row_count: 18, ...extra,
  }
}

const COLUMNS = [
  column("id", "int8", { is_primary: true, column_default: "nextval('message_id_seq'::regclass)" }),
  column("body", "text"),
  column("created_at", "timestamptz", { column_default: "now()" }),
  column("note", "text", { is_nullable: "YES", column_default: "'none'::text" }),
]

export interface Browser {
  container: HTMLElement
  inserts: unknown[]
  unmount: () => void
}

function restAnswer(init: RequestInit | undefined, inserts: unknown[]): Response {
  const headers = new Headers(init?.headers)
  if (init?.method === "POST") {
    inserts.push(JSON.parse(String(init.body)))
    return Response.json([], { status: 201 })
  }
  const [from = 0, to = 0] = (headers.get("Range") ?? "0-24").split("-").map(Number)
  const page = ROWS.slice(from, to + 1)
  const total = (headers.get("Prefer") ?? "").includes("count=") ? String(ROWS.length) : "*"
  return Response.json(page, { headers: { "Content-Range": `${from}-${from + page.length - 1}/${total}` } })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** The data browser on `message`, rendered and settled. */
export async function renderBrowser(): Promise<Browser> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const inserts: unknown[] = []
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/metadata/introspect")) return Response.json({ rows: COLUMNS, rowCount: COLUMNS.length })
    if (url.pathname.includes("/rest/v1/")) return restAnswer(init, inserts)
    return Response.json({ rows: [], rowCount: 0 })
  })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={testClient({ url: PROXY, token: "t" })}>
            <DataExplorer initialTable="message" />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
  return { container, inserts, unmount: () => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() } }
}

/** The button reading exactly `text`. */
export function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no "${text}" button`)
  return found
}

/** Open Insert Row, type `body` into the body field only, and insert. */
export async function insertBody(container: HTMLElement, body: string): Promise<void> {
  await act(async () => button(container, "+ Insert Row").click())
  const input = Array.from(container.querySelectorAll("input")).find((i) => i.closest("div")?.textContent?.startsWith("body"))
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, body)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button(container, "Insert Row").click())
  await settle()
}
