import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryBuilder, MutationBuilder } from "../src/query.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE = "http://localhost:8000"
const PATH = "/rest/v1/posts"
const HEADERS: Record<string, string> = { apikey: "anon-key", "Content-Type": "application/json" }

interface Post { id: string; title: string; status: string }

function mockFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number; contentRange?: string } = {},
): ReturnType<typeof vi.fn> {
  const { ok = true, status = ok ? 200 : 400, contentRange } = opts
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: {
      get: (key: string) => (key === "content-range" ? (contentRange ?? null) : null),
    },
  })
}

function captureUrl(): { url: () => string; fetch: ReturnType<typeof vi.fn> } {
  const fetch = mockFetch([])
  vi.stubGlobal("fetch", fetch)
  return {
    fetch,
    url: () => (fetch.mock.calls[0] as [string, unknown])[0],
  }
}

// ─── QueryBuilder ─────────────────────────────────────────────────────────────

describe("QueryBuilder — URL construction", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends request to base + path with no params", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS)
    expect(url()).toBe(`${BASE}${PATH}`)
  })

  it("constructor columns argument sets select param", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS, "id,title")
    expect(url()).toContain("select=id%2Ctitle")
  })

  it(".select() sets select param", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).select("id,status")
    expect(url()).toContain("select=id%2Cstatus")
  })

  it(".eq() appends equality filter", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).eq("status", "published")
    expect(url()).toContain("status=eq.published")
  })

  it(".neq() appends inequality filter", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).neq("status", "draft")
    expect(url()).toContain("status=neq.draft")
  })

  it(".gt() and .gte() append range filters", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).gt("views", 100).gte("likes", 5)
    expect(url()).toContain("views=gt.100")
    expect(url()).toContain("likes=gte.5")
  })

  it(".lt() and .lte() append range filters", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).lt("priority", 10).lte("score", 99)
    expect(url()).toContain("priority=lt.10")
    expect(url()).toContain("score=lte.99")
  })

  it(".like() appends like filter", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).like("title", "%hello%")
    expect(url()).toContain("title=like.")
  })

  it(".ilike() appends case-insensitive like filter", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).ilike("title", "%hello%")
    expect(url()).toContain("title=ilike.")
  })

  it(".in() generates PostgREST in() syntax", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).in("status", ["draft", "published"])
    // URLSearchParams encodes parens; decode before asserting semantic content
    expect(decodeURIComponent(url())).toContain("status=in.(draft,published)")
  })

  it(".is() generates is.null syntax", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).is("deleted_at", null)
    expect(url()).toContain("deleted_at=is.null")
  })

  it(".order() ascending (default)", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).order("created_at")
    expect(url()).toContain("order=created_at.asc.nullslast")
  })

  it(".order() descending", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).order("created_at", { ascending: false })
    expect(url()).toContain("order=created_at.desc.nullslast")
  })

  it(".order() nullsFirst", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).order("created_at", { nullsFirst: true })
    expect(url()).toContain("nullsfirst")
  })

  it(".limit() sets limit param", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).limit(20)
    expect(url()).toContain("limit=20")
  })

  it(".range() sets Range header", async () => {
    const fetch = mockFetch([])
    vi.stubGlobal("fetch", fetch)
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).range(10, 19)
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["Range"]).toBe("10-19")
  })

  it("multiple chained filters all appear in URL", async () => {
    const { url } = captureUrl()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS)
      .eq("status", "published")
      .gte("views", 100)
      .order("created_at", { ascending: false })
      .limit(10)
    const u = url()
    expect(u).toContain("status=eq.published")
    expect(u).toContain("views=gte.100")
    expect(u).toContain("order=created_at.desc.nullslast")
    expect(u).toContain("limit=10")
  })
})

describe("QueryBuilder — results", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("returns data array on success", async () => {
    const rows = [{ id: "1", title: "Hello", status: "published" }]
    vi.stubGlobal("fetch", mockFetch(rows))
    const { data, error, count } = await new QueryBuilder<Post>(BASE, PATH, HEADERS)
    expect(error).toBeNull()
    expect(data).toEqual(rows)
    expect(count).toBeNull() // no content-range header
  })

  it("parses count from content-range header", async () => {
    vi.stubGlobal("fetch", mockFetch([{ id: "1", title: "A", status: "x" }], { contentRange: "0-0/42" }))
    const { count } = await new QueryBuilder<Post>(BASE, PATH, HEADERS)
    expect(count).toBe(42)
  })

  it("returns error on non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetch({ message: "Unauthorized" }, { ok: false, status: 401 }))
    const { data, error } = await new QueryBuilder<Post>(BASE, PATH, HEADERS)
    expect(data).toBeNull()
    expect(error?.message).toBe("Unauthorized")
    expect(error?.status).toBe(401)
  })

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")))
    const { data, error } = await new QueryBuilder<Post>(BASE, PATH, HEADERS)
    expect(data).toBeNull()
    expect(error?.message).toBe("Network error")
  })
})

describe("QueryBuilder.single()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends Accept: application/vnd.pgrst.object+json header", async () => {
    const fetch = mockFetch({ id: "1", title: "Hello", status: "published" })
    vi.stubGlobal("fetch", fetch)
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).single()
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["Accept"]).toContain("pgrst.object+json")
  })

  it("returns single row", async () => {
    vi.stubGlobal("fetch", mockFetch({ id: "1", title: "Hello", status: "published" }))
    const { data, error } = await new QueryBuilder<Post>(BASE, PATH, HEADERS).single()
    expect(error).toBeNull()
    expect(data).toEqual({ id: "1", title: "Hello", status: "published" })
  })
})

describe("QueryBuilder.maybeSingle()", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("returns null for empty array", async () => {
    vi.stubGlobal("fetch", mockFetch([]))
    const { data, error } = await new QueryBuilder<Post>(BASE, PATH, HEADERS).maybeSingle()
    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it("returns first element when array has rows", async () => {
    vi.stubGlobal("fetch", mockFetch([{ id: "1", title: "A", status: "published" }, { id: "2", title: "B", status: "draft" }]))
    const { data } = await new QueryBuilder<Post>(BASE, PATH, HEADERS).maybeSingle()
    expect(data).toEqual({ id: "1", title: "A", status: "published" })
  })
})

// ─── MutationBuilder ──────────────────────────────────────────────────────────

describe("MutationBuilder — insert", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("sends POST with body", async () => {
    const fetch = mockFetch([{ id: "1", title: "New", status: "draft" }])
    vi.stubGlobal("fetch", fetch)
    const { data, error } = await new MutationBuilder<Post>(BASE, PATH, HEADERS, "POST", { title: "New", status: "draft" })
    expect(error).toBeNull()
    expect(data?.[0]?.id).toBe("1")
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe("POST")
    expect(opts.body as string).toContain("New")
  })

  it("returns error on non-ok", async () => {
    vi.stubGlobal("fetch", mockFetch({ message: "Conflict" }, { ok: false, status: 409 }))
    const { error } = await new MutationBuilder<Post>(BASE, PATH, HEADERS, "POST", {})
    expect(error?.message).toBe("Conflict")
    expect(error?.status).toBe(409)
  })
})

describe("MutationBuilder — update / delete", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("update sends PATCH with eq filter in URL", async () => {
    const fetch = mockFetch([{ id: "1", title: "Updated", status: "published" }])
    vi.stubGlobal("fetch", fetch)
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "PATCH", { title: "Updated" }).eq("id", "1")
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe("PATCH")
    expect(url).toContain("id=eq.1")
  })

  it("delete sends DELETE with eq filter", async () => {
    const fetch = mockFetch(null, { status: 204 })
    vi.stubGlobal("fetch", fetch)
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").eq("id", "1")
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe("DELETE")
    expect(url).toContain("id=eq.1")
  })

  it("204 No Content returns empty data array", async () => {
    vi.stubGlobal("fetch", mockFetch(null, { status: 204 }))
    const { data, error } = await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").eq("id", "1")
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it("upsert sets Prefer: resolution=merge-duplicates header", async () => {
    const fetch = mockFetch([{ id: "1", title: "A", status: "draft" }])
    vi.stubGlobal("fetch", fetch)
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "POST", { id: "1", title: "A", status: "draft" }, { upsert: true })
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["Prefer"]).toContain("merge-duplicates")
  })
})
