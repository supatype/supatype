import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { createClient, forgetRegisteredDraftModels, registerDraftModels, type AnyDatabase, type DraftUpdateOptions, type UpdateOptions } from "../src/index.js"
import { runMutation } from "../src/bindings.js"
import { fetchCalls, header, jsonBody, jsonResponse, mockFetch, requestUrl, type FetchMock } from "./support/fetch-mock.js"

// An update on a model that keeps drafts saves a new draft of each record it matches, through
// `supatype.save_drafts`, and leaves the live rows as they are: they change only when a version is
// published. `{ publish: true }` saves and publishes in the same call. These pin which requests go
// out and what the caller gets back.

const BASE = "http://localhost:18473"
const ID = "7b1f115e-418d-4e92-91d0-f199ebd06e5e"
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const DRAFT = { id: ID, title: "Edited", published_at: "2026-10-18T10:00:00Z" }
const SAVED = { record_id: ID, version: 2, status: "draft", created_at: "2026-10-22T08:00:00Z" }

/**
 * Answers as the database does for an editor: the table read names the matched records, `save_drafts`
 * saves a version of each, and the draft view reads them back.
 */
function draftsServer(matched: readonly string[] = [ID]): FetchMock {
  return mockFetch((input, init) => {
    const url = new URL(requestUrl(input))
    if (url.pathname.endsWith("/rpc/save_drafts")) {
      return Promise.resolve(jsonResponse(matched.map((id) => ({ ...SAVED, record_id: id }))))
    }
    if (init?.method === "PATCH") return Promise.resolve(jsonResponse([{ ...DRAFT, title: "Live!" }]))
    if (header(init ?? {}, "Accept-Profile") === "draft") return Promise.resolve(jsonResponse([DRAFT]))
    return Promise.resolve(jsonResponse(matched.map((id) => ({ id }))))
  })
}

function serve(fetch: FetchMock): FetchMock {
  vi.stubGlobal("fetch", fetch)
  return fetch
}

// Untyped, as a project whose schema the test fixtures do not describe.
const client = () => createClient<AnyDatabase>({ url: BASE, anonKey: "anon-key" })

describe("update on a model that keeps drafts", () => {
  beforeEach(() => registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } }))
  afterEach(() => {
    forgetRegisteredDraftModels()
    vi.unstubAllGlobals()
  })

  it("reads the keys of the records its filters match, as the caller reads the table", async () => {
    const fetch = serve(draftsServer())
    await client().from("posts").update({ title: "Edited" }).eq("id", ID)
    const [match] = fetchCalls(fetch)
    const url = new URL(match?.url ?? "")
    expect(match?.init.method).toBe("GET")
    expect(url.pathname).toBe("/rest/v1/posts")
    expect(url.searchParams.get("id")).toBe(`eq.${ID}`)
    expect(url.searchParams.get("select")).toBe("id")
    expect(header(match?.init ?? {}, "Accept-Profile")).toBeNull()
  })

  it("saves a draft of each through supatype.save_drafts and never patches the live row", async () => {
    const fetch = serve(draftsServer([ID, ID_B]))
    await client().from("posts").update({ title: "Edited" }).in("id", [ID, ID_B])
    const calls = fetchCalls(fetch)
    const save = calls[1]
    expect(save?.url).toBe(`${BASE}/rest/v1/rpc/save_drafts`)
    expect(save?.init.method).toBe("POST")
    expect(header(save?.init ?? {}, "Content-Profile")).toBe("supatype")
    expect(jsonBody(save?.init ?? {})).toEqual({
      model_table: "posts",
      record_ids: [ID, ID_B],
      data: { title: "Edited" },
      publish: false,
    })
    expect(calls.map((call) => call.init.method)).not.toContain("PATCH")
  })

  it("returns the draft rows, read back from the draft view with the update's select", async () => {
    const fetch = serve(draftsServer())
    const { data, error, count } = await client().from("posts").update({ title: "Edited" }).eq("id", ID).select("id, title")
    const readBack = fetchCalls(fetch)[2]
    const url = new URL(readBack?.url ?? "")
    expect(url.searchParams.get("id")).toBe(`in.(${ID})`)
    expect(url.searchParams.get("select")).toBe("id, title")
    expect(header(readBack?.init ?? {}, "Accept-Profile")).toBe("draft")
    expect(error).toBeNull()
    expect(data).toEqual([DRAFT])
    expect(count).toBe(1)
  })

  it("publishes in the same call with { publish: true }", async () => {
    const fetch = serve(draftsServer())
    const { error } = await client().from("posts").update({ title: "Edited" }, { publish: true }).eq("id", ID)
    expect(error).toBeNull()
    expect(jsonBody(fetchCalls(fetch)[1]?.init ?? {})["publish"]).toBe(true)
  })

  it("saves nothing when the filters match no record, as a PATCH that matches nothing", async () => {
    const fetch = serve(draftsServer([]))
    const { data, error, count } = await client().from("posts").update({ title: "Edited" }).eq("id", ID)
    expect(fetchCalls(fetch)).toHaveLength(1)
    expect({ data, error, count }).toEqual({ data: [], error: null, count: 0 })
  })

  it("passes save_drafts' refusal through and reads nothing back", async () => {
    const refused = { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "posts_versions"' }
    const fetch = serve(
      mockFetch((input) =>
        Promise.resolve(requestUrl(input).includes("/rpc/") ? jsonResponse(refused, 403) : jsonResponse([{ id: ID }])),
      ),
    )
    const { data, error } = await client().from("posts").update({ title: "Edited" }).eq("id", ID)
    expect(data).toBeNull()
    expect(error).toMatchObject({ code: "42501", status: 403 })
    expect(fetchCalls(fetch)).toHaveLength(2)
  })

  it("reaches the framework bindings, which update through runMutation", async () => {
    const fetch = serve(draftsServer())
    const outcome = await runMutation(client(), "posts", "update", { title: "Edited" }, { id: ID }, { publish: true })
    expect(fetchCalls(fetch)[1]?.url).toBe(`${BASE}/rest/v1/rpc/save_drafts`)
    expect(jsonBody(fetchCalls(fetch)[1]?.init ?? {})["publish"]).toBe(true)
    expect(outcome.data).toEqual([DRAFT])
  })
})

describe("update on a model that keeps no drafts", () => {
  afterEach(() => {
    forgetRegisteredDraftModels()
    vi.unstubAllGlobals()
  })

  it("is a plain PATCH asking for the rows back", async () => {
    registerDraftModels({ version: 1, tables: { posts: { primaryKey: "id" } } })
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([{ id: 1, label: "news" }]))))
    const { data } = await client().from("tags").update({ label: "news" }).eq("id", 1)
    const [only] = fetchCalls(fetch)
    expect(fetchCalls(fetch)).toHaveLength(1)
    expect(only?.init.method).toBe("PATCH")
    expect(only?.url).toBe(`${BASE}/rest/v1/tags?id=eq.1`)
    expect(header(only?.init ?? {}, "Prefer")).toContain("return=representation")
    expect(data).toEqual([{ id: 1, label: "news" }])
  })

  it("is a plain PATCH when nothing was registered, as for a client built without the generated file", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([DRAFT]))))
    await client().from("posts").update({ title: "Edited" }).eq("id", ID)
    expect(fetchCalls(fetch).map((call) => call.init.method)).toEqual(["PATCH"])
  })

  it("refuses { publish: true } without sending anything, since there is nothing to publish", async () => {
    const fetch = serve(mockFetch(() => Promise.resolve(jsonResponse([]))))
    const { data, error } = await client().from("tags").update({ label: "news" }, { publish: true }).eq("id", 1)
    expect(fetchCalls(fetch)).toHaveLength(0)
    expect(data).toBeNull()
    expect(error?.message).toContain("keeps drafts")
    expect(error?.message).toContain("./supatype/generated/client")
  })
})

// Checked by `tsc -p tests/tsconfig.json`, not by vitest.
type Post = { Row: { id: string; title: string }; Insert: { title: string }; Update: { title?: string }; Drafts: true }
type Tag = { Row: { id: number; label: string }; Insert: { label: string }; Update: { label?: string } }
type Blog = { public: { Tables: { posts: Post; tags: Tag } } }

describe("the publish option's types", () => {
  it("exists on a drafts model and not on any other", () => {
    expectTypeOf<UpdateOptions<Post>>().toEqualTypeOf<DraftUpdateOptions>()
    expectTypeOf<UpdateOptions<Tag>>().toBeNever()
    const typed = createClient<Blog>({ url: BASE, anonKey: "anon-key" })
    void typed.from("posts").update({ title: "x" }, { publish: true })
    // @ts-expect-error a model with no drafts has nothing to publish
    void typed.from("tags").update({ label: "x" }, { publish: true })
  })
})
