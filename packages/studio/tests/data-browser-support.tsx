import React from "react"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { DataExplorer } from "../src/views/DataExplorer.js"
import type { AdminConfig } from "../src/config.js"
import { act, button, mount, settle, testClient, testConfig, type Mounted } from "./support.js"

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

/** A request that changed something: a PATCH, DELETE, insert or function call. */
export interface Write {
  method: string
  /** The path, with the query that names the rows: `/rest/v1/message?id=eq.1`. */
  path: string
  body: unknown
}

export interface Browser extends Mounted {
  inserts: unknown[]
  /** Every row read the browser sent, in order. */
  reads: URL[]
  /** Every write the browser sent, in order. */
  writes: Write[]
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

/** The id `create_record` gives the record it creates. */
export const CREATED_ID = "31"

/**
 * The answer to a write that is not an insert: `create_record` the new record's id, any other
 * function the record ids, and a PATCH no rows.
 */
function writeAnswer(url: URL, init: RequestInit, writes: Write[]): Response {
  const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null
  writes.push({ method: init.method ?? "GET", path: `${url.pathname.replace(/^.*\/rest\//, "/rest/")}${url.search}`, body })
  if (url.pathname.endsWith("/rpc/create_record")) return Response.json({ record_id: CREATED_ID })
  return url.pathname.includes("/rpc/") ? Response.json(["1"]) : Response.json([])
}

function stubProject(options: BrowserOptions, record: Pick<Browser, "inserts" | "reads" | "writes">): void {
  const columns = options.columns ?? COLUMNS
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/metadata/introspect")) return Response.json({ rows: columns, rowCount: columns.length })
    if (!url.pathname.includes("/rest/v1/")) return Response.json({ rows: [], rowCount: 0 })
    const method = init?.method ?? "GET"
    if (method === "GET") record.reads.push(url)
    const isInsert = method === "POST" && !url.pathname.includes("/rpc/")
    if (init !== undefined && method !== "GET" && !isInsert) return writeAnswer(url, init, record.writes)
    return restAnswer(init, record.inserts, options)
  })
}

/**
 * The data browser on `message`, rendered and settled. Settling runs on the virtual clock, so the
 * file calls `isolateEachTest()`, which also unmounts it after the test.
 */
export async function renderBrowser(options: BrowserOptions = {}): Promise<Browser> {
  const record: Pick<Browser, "inserts" | "reads" | "writes"> = { inserts: [], reads: [], writes: [] }
  stubProject(options, record)
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
  return { ...view, ...record }
}

/** The table cell of `column` (its place in `message`'s columns) on the first row. */
export function firstRowCell(container: HTMLElement, column: number): HTMLTableCellElement {
  // The row's first cell is its selection checkbox.
  const cell = container.querySelector("tbody tr")?.querySelectorAll("td")[column + 1]
  if (!(cell instanceof HTMLTableCellElement)) throw new Error(`no cell ${column} on the first row`)
  return cell
}

/** Double-click the first row's `column` cell, type `text` over its value, and press Enter. */
export async function editFirstRowCell(container: HTMLElement, column: number, text: string): Promise<void> {
  const cell = firstRowCell(container, column)
  await act(async () => cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
  const input = cell.querySelector("input")
  await typeInto(input, text)
  await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  await settle()
}

/** Set `input`'s value as typing does, so React's onChange sees it. */
async function typeInto(input: HTMLInputElement | null | undefined, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, text)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** Open Insert Row, type `body` into the body field only, and insert. */
export async function insertBody(container: HTMLElement, body: string): Promise<void> {
  await act(async () => button(container, "+ Insert Row").click())
  const input = Array.from(container.querySelectorAll("input")).find((i) => i.closest("div")?.textContent?.startsWith("body"))
  await typeInto(input, body)
  await act(async () => button(container, "Insert Row").click())
  await settle()
}
