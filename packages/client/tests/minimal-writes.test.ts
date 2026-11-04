import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { createClient, forgetRegisteredDraftModels, registerDraftModels, type AnyDatabase, type QueryResult } from "../src/index.js"
import { fetchCalls, header, jsonResponse, mockFetch, requestUrl, type FetchMock } from "./support/fetch-mock.js"

// A write asks for no rows back unless `.select()` says to, as postgrest-js does. Returning a row
// needs SELECT on it, so a table whose rules let a caller create but not read refused every insert
// that asked: an anon order form, say, answered 401 42501 for a row it was allowed to write.

const BASE = "http://localhost:18473"
const ID = "7b1f115e-418d-4e92-91d0-f199ebd06e5e"
const ROW = { id: ID, title: "Mine" }

/** PostgREST answering a write that asked for nothing back: 201 or 204, and no body. */
function minimalServer(): FetchMock {
  return mockFetch((_input, init) => {
    const prefer = header(init ?? {}, "Prefer") ?? ""
    if (prefer.includes("return=representation")) return Promise.resolve(jsonResponse([ROW], 201))
    return Promise.resolve(new Response(null, { status: init?.method === "POST" ? 201 : 204 }))
  })
}

function serve(fetch: FetchMock): FetchMock {
  vi.stubGlobal("fetch", fetch)
  return fetch
}

const client = () => createClient<AnyDatabase>({ url: BASE, anonKey: "anon-key", auth: { persistSession: false } })

describe("a write without select()", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("insert asks for no representation and resolves to no rows", async () => {
    const fetch = serve(minimalServer())
    const result = await client().from("orders").insert({ title: "Mine" })
    expect(header(fetchCalls(fetch)[0]?.init ?? {}, "Prefer")).toBeNull()
    expect(result).toEqual({ data: null, error: null, count: null })
  })

  it("update asks for no representation and resolves to no rows", async () => {
    const fetch = serve(minimalServer())
    const result = await client().from("orders").update({ title: "Edited" }).eq("id", ID)
    expect(header(fetchCalls(fetch)[0]?.init ?? {}, "Prefer")).toBeNull()
    expect(result).toEqual({ data: null, error: null, count: null })
  })

  it("upsert keeps only its conflict resolution", async () => {
    const fetch = serve(minimalServer())
    const result = await client().from("orders").upsert({ id: ID, title: "Mine" })
    expect(header(fetchCalls(fetch)[0]?.init ?? {}, "Prefer")).toBe("resolution=merge-duplicates")
    expect(result.data).toBeNull()
  })

  it("delete resolves to no rows", async () => {
    serve(minimalServer())
    const result = await client().from("orders").delete().eq("id", ID)
    expect(result).toEqual({ data: null, error: null, count: null })
  })
})

describe("a write with select()", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("asks for the representation and resolves to the rows", async () => {
    const fetch = serve(minimalServer())
    const { data, count } = await client().from("orders").insert({ title: "Mine" }).select()
    expect(header(fetchCalls(fetch)[0]?.init ?? {}, "Prefer")).toBe("return=representation")
    expect({ data, count }).toEqual({ data: [ROW], count: 1 })
  })
})

describe("a drafts-model write without select()", () => {
  beforeEach(() => registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } }))
  afterEach(() => {
    forgetRegisteredDraftModels()
    vi.unstubAllGlobals()
  })

  /** create_record and save_drafts answer with the record keys; a table read names the matches. */
  function draftsServer(): FetchMock {
    return mockFetch((input) => {
      const url = requestUrl(input)
      if (url.endsWith("/rpc/create_record")) return Promise.resolve(jsonResponse({ record_id: ID, version: 1 }))
      if (url.endsWith("/rpc/save_drafts")) return Promise.resolve(jsonResponse([{ record_id: ID, version: 2 }]))
      return Promise.resolve(jsonResponse([ROW]))
    })
  }

  it("insert creates the record and reads nothing back", async () => {
    const fetch = serve(draftsServer())
    const result = await client().from("posts").insert({ title: "Mine" })
    expect(fetchCalls(fetch).map(({ url }) => url)).toEqual([`${BASE}/rest/v1/rpc/create_record`])
    expect(result).toEqual({ data: null, error: null, count: null })
  })

  it("update saves the drafts and reads none of them back", async () => {
    const fetch = serve(draftsServer())
    const result = await client().from("posts").update({ title: "Edited" }).eq("id", ID)
    expect(fetchCalls(fetch).map(({ url }) => new URL(url).pathname)).toEqual(["/rest/v1/posts", "/rest/v1/rpc/save_drafts"])
    expect(result).toEqual({ data: null, error: null, count: null })
  })
})

// Checked by `tsc -p tests/tsconfig.json`, not by vitest.
type Order = { Row: { id: string; title: string }; Insert: { title: string }; Update: { title?: string } }
type Shop = { public: { Tables: { orders: Order } } }

describe("the types of a write", () => {
  it("resolve to null without select(), to rows with it, and allow single() only after it", () => {
    const typed = createClient<Shop>({ url: BASE, anonKey: "anon-key" })
    expectTypeOf(typed.from("orders").insert({ title: "x" })).resolves.toEqualTypeOf<QueryResult<null>>()
    expectTypeOf(typed.from("orders").insert({ title: "x" }).select("id")).resolves.toEqualTypeOf<QueryResult<{ id: string }[]>>()
    void typed.from("orders").insert({ title: "x" }).select().single()
    // @ts-expect-error a write returns no row until select() asks for one
    void typed.from("orders").insert({ title: "x" }).single()
    // @ts-expect-error a write returns no row until select() asks for one
    void typed.from("orders").update({ title: "x" }).eq("id", ID).maybeSingle()
  })
})
