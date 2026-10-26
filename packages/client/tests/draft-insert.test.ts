import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient, forgetRegisteredDraftModels, registerDraftModels, type AnyDatabase } from "../src/index.js"
import { runMutation } from "../src/bindings.js"
import { fetchCalls, header, jsonBody, jsonResponse, mockFetch, requestUrl, type FetchMock } from "./support/fetch-mock.js"

// An insert on a model that keeps drafts is created through `supatype.create_record` and read back
// from the draft view. A plain insert asking for the row back is refused there by a read rule that
// hides unpublished records (Postgres checks the returned row against it before anything has made
// the new row visible to its author), so these pin which request goes out, and that the caller gets
// the row an insert returns.

const BASE = "http://localhost:18473"
const ID = "7b1f115e-418d-4e92-91d0-f199ebd06e5e"
const ROW = { id: ID, title: "Mine", body: { en: "hi" }, published_at: null }
const CREATED = { record_id: ID, version: 1, status: "draft", created_at: "2026-10-18T10:00:00Z" }

/** PostgREST's answer to a plain insert asking for an unpublished row back, recorded from v14.18. */
const REFUSED = { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "posts"' }

/**
 * Answers as the database does for an editor whose read rule hides unpublished records:
 * `create_record` makes the record, the draft view reads it, and a plain insert asking for the row
 * back is refused.
 */
function draftsServer(): FetchMock {
  return mockFetch((input, init) => {
    const url = requestUrl(input)
    if (url.endsWith("/rest/v1/rpc/create_record")) return Promise.resolve(jsonResponse(CREATED))
    if (init?.method === "POST") return Promise.resolve(jsonResponse(REFUSED, 403))
    return Promise.resolve(jsonResponse([ROW]))
  })
}

function serve(fetch: FetchMock): FetchMock {
  vi.stubGlobal("fetch", fetch)
  return fetch
}

// Untyped, as a project whose schema the test fixtures do not describe.
const client = () => createClient<AnyDatabase>({ url: BASE, anonKey: "anon-key" })

describe("insert on a model that keeps drafts", () => {
  beforeEach(() => registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } }))
  afterEach(() => {
    forgetRegisteredDraftModels()
    vi.unstubAllGlobals()
  })

  it("creates the record through supatype.create_record", async () => {
    const fetch = serve(draftsServer())
    await client().from("posts").insert({ title: "Mine", body: { en: "hi" } })
    const [create] = fetchCalls(fetch)
    expect(create?.url).toBe(`${BASE}/rest/v1/rpc/create_record`)
    expect(create?.init.method).toBe("POST")
    expect(header(create?.init ?? {}, "Content-Profile")).toBe("supatype")
    expect(jsonBody(create?.init ?? {})).toEqual({ model_table: "posts", data: { title: "Mine", body: { en: "hi" } } })
  })

  it("reads the new record back from the draft view, by its key, with the insert's select", async () => {
    const fetch = serve(draftsServer())
    await client().from("posts").insert({ title: "Mine" }).select("id, title")
    const readBack = fetchCalls(fetch)[1]
    const url = new URL(readBack?.url ?? "")
    expect(url.pathname).toBe("/rest/v1/posts")
    expect(url.searchParams.get("id")).toBe(`eq.${ID}`)
    expect(url.searchParams.get("select")).toBe("id, title")
    expect(header(readBack?.init ?? {}, "Accept-Profile")).toBe("draft")
  })

  it("returns the row as a plain insert would", async () => {
    serve(draftsServer())
    const { data, error, count } = await client().from("posts").insert({ title: "Mine" })
    expect(error).toBeNull()
    expect(data).toEqual([ROW])
    expect(count).toBe(1)
  })

  it("answers single() with the one row", async () => {
    serve(draftsServer())
    const { data, error } = await client().from("posts").insert({ title: "Mine" }).select().single()
    expect(error).toBeNull()
    expect(data).toEqual(ROW)
  })

  it("treats a one-row array as one record", async () => {
    const fetch = serve(draftsServer())
    const { data } = await client().from("posts").insert([{ title: "Mine" }])
    expect(fetchCalls(fetch)[0]?.url).toBe(`${BASE}/rest/v1/rpc/create_record`)
    expect(jsonBody(fetchCalls(fetch)[0]?.init ?? {})["data"]).toEqual({ title: "Mine" })
    expect(data).toEqual([ROW])
  })

  it("passes create_record's refusal through and reads nothing back", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse(REFUSED, 403))))
    const { data, error } = await client().from("posts").insert({ title: "Mine" })
    expect(data).toBeNull()
    expect(error).toMatchObject({ code: "42501", status: 403 })
    expect(fetchCalls(fetch)).toHaveLength(1)
  })

  it("keeps several rows as one plain insert, which stays all or nothing", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([ROW, ROW], 201))))
    await client().from("posts").insert([{ title: "A" }, { title: "B" }])
    expect(fetchCalls(fetch).map((call) => call.url)).toEqual([`${BASE}/rest/v1/posts`])
  })

  it("hands the caller the gateway's hint when a plain insert is refused", async () => {
    const hint = "This model keeps drafts: create records with supatype.create_record."
    serve(mockFetch(() => Promise.resolve(jsonResponse({ ...REFUSED, hint }, 403))))
    const { error } = await client().from("posts").insert([{ title: "A" }, { title: "B" }])
    expect(error).toMatchObject({ code: "42501", status: 403, hint })
  })

  it("leaves upsert a plain write, since create_record cannot say what a conflict does", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([ROW], 201))))
    await client().from("posts").upsert({ id: ID, title: "Mine" })
    expect(fetchCalls(fetch).map((call) => call.url)).toEqual([`${BASE}/rest/v1/posts`])
  })

  it("reaches the framework bindings, which insert through runMutation", async () => {
    const fetch = serve(draftsServer())
    const outcome = await runMutation(client(), "posts", "insert", { title: "Mine" })
    expect(fetchCalls(fetch)[0]?.url).toBe(`${BASE}/rest/v1/rpc/create_record`)
    expect(outcome.data).toEqual([ROW])
  })
})

describe("insert on a model that keeps no drafts", () => {
  afterEach(() => {
    forgetRegisteredDraftModels()
    vi.unstubAllGlobals()
  })

  it("is a plain insert asking for the row back", async () => {
    registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } })
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([{ id: 1 }], 201))))
    await client().from("tags").insert({ label: "news" })
    const [only] = fetchCalls(fetch)
    expect(only?.url).toBe(`${BASE}/rest/v1/tags`)
    expect(header(only?.init ?? {}, "Prefer")).toContain("return=representation")
  })

  it("is a plain insert when nothing was registered, as for a client built without the generated file", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([ROW], 201))))
    await client().from("posts").insert({ title: "Mine" })
    expect(fetchCalls(fetch).map((call) => call.url)).toEqual([`${BASE}/rest/v1/posts`])
  })

  it("ignores a document from a newer generator", async () => {
    registerDraftModels({ version: 2, tables: { posts: { primaryKey: "id" } } })
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([ROW], 201))))
    await client().from("posts").insert({ title: "Mine" })
    expect(fetchCalls(fetch).map((call) => call.url)).toEqual([`${BASE}/rest/v1/posts`])
  })
})
