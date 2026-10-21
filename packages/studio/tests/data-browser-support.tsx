import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { DataExplorer } from "../src/views/DataExplorer.js"
import type { AdminConfig } from "../src/config.js"
import { mount, settle, testClient, testConfig, unmount } from "./support.js"

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

/** `message` with no primary key: what a table created outside the schema can look like. */
export const KEYLESS_COLUMNS = COLUMNS.map((c) => ({ ...c, is_primary: false }))

export interface Browser {
  container: HTMLElement
  inserts: unknown[]
  /** Every row read the browser sent, in order. */
  reads: URL[]
  unmount: () => void
}

export interface BrowserOptions {
  /** The admin config the browser sees; none of its models by default. */
  config?: AdminConfig
  /** The introspected columns of `message`. */
  columns?: Record<string, unknown>[]
  /** The answer to every insert, in place of a 201: a PostgREST error body and its status. */
  insertRefusal?: { status: number; body: Record<string, unknown> }
  /** The rows of `message`; thirty numbered messages by default. */
  rows?: Array<Record<string, unknown>>
}

function restAnswer(init: RequestInit | undefined, inserts: unknown[], options: BrowserOptions): Response {
  const headers = new Headers(init?.headers)
  const refusal = options.insertRefusal
  if (init?.method === "POST") {
    inserts.push(JSON.parse(String(init.body)))
    return refusal === undefined ? Response.json([], { status: 201 }) : Response.json(refusal.body, { status: refusal.status })
  }
  const rows = options.rows ?? ROWS
  const [from = 0, to = 0] = (headers.get("Range") ?? "0-24").split("-").map(Number)
  const page = rows.slice(from, to + 1)
  const total = (headers.get("Prefer") ?? "").includes("count=") ? String(rows.length) : "*"
  return Response.json(page, { headers: { "Content-Range": `${from}-${from + page.length - 1}/${total}` } })
}

function stubProject(options: BrowserOptions, inserts: unknown[], reads: URL[]): void {
  const columns = options.columns ?? COLUMNS
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/metadata/introspect")) return Response.json({ rows: columns, rowCount: columns.length })
    if (url.pathname.includes("/rest/v1/")) {
      if (init?.method === undefined || init.method === "GET") reads.push(url)
      return restAnswer(init, inserts, options)
    }
    return Response.json({ rows: [], rowCount: 0 })
  })
}

/**
 * The data browser on `message`, rendered and settled. Settling runs on the virtual clock, so the
 * file calls `isolateEachTest()`, which also unmounts it after the test.
 */
export async function renderBrowser(options: BrowserOptions = {}): Promise<Browser> {
  const inserts: unknown[] = []
  const reads: URL[] = []
  stubProject(options, inserts, reads)
  const view = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={options.config ?? testConfig()}>
        <AdminClientContext.Provider value={testClient({ url: PROXY, token: "t" })}>
          <DataExplorer initialTable="message" />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { container: view.container, inserts, reads, unmount: () => { unmount(view); vi.unstubAllGlobals() } }
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
