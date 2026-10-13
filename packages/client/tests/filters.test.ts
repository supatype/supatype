import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryBuilder, MutationBuilder } from "../src/query.js"

const BASE = "http://localhost:18473"
const PATH = "/rest/v1/posts"
const HEADERS: Record<string, string> = { apikey: "anon-key", "Content-Type": "application/json" }

interface Post { id: string; title: string; tags: string[]; meta: Record<string, unknown> }

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue([]),
    text: vi.fn().mockResolvedValue("[]"),
    headers: { get: () => null },
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** The filters exactly as PostgREST will read them, after URL decoding. */
function sentFilters(fetch: ReturnType<typeof vi.fn>): string[] {
  const [url] = fetch.mock.calls[0] as [string, RequestInit]
  return [...new URL(url).searchParams.entries()].map(([key, value]) => `${key}=${value}`)
}

describe("contains / containedBy: PostgREST operand syntax", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("an array becomes a Postgres array literal, not JSON", async () => {
    const fetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).contains("tags", ["a", "b"])
    expect(sentFilters(fetch)).toEqual(["tags=cs.{a,b}"])
  })

  it("array elements PostgreSQL would split or misread are quoted and escaped", async () => {
    const fetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).containedBy("tags", [
      "plain",
      "a,b",
      "with space",
      'say "hi"',
      "back\\slash",
      "{brace}",
      "",
      "null",
      7,
      null,
    ])
    expect(sentFilters(fetch)).toEqual([
      'tags=cd.{plain,"a,b","with space","say \\"hi\\"","back\\\\slash","{brace}","","null",7,NULL}',
    ])
  })

  it("an object becomes JSON, for jsonb columns", async () => {
    const fetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).contains("meta", { tier: "gold" })
    expect(sentFilters(fetch)).toEqual(['meta=cs.{"tier":"gold"}'])
  })

  it("a string is sent as written, for range types and hand-written literals", async () => {
    const fetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).containedBy("during", "[2026-01-01,2026-02-01)")
    expect(sentFilters(fetch)).toEqual(["during=cd.[2026-01-01,2026-02-01)"])
  })
})

describe("in(): values PostgREST would split are quoted", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("quotes a value holding a comma or parenthesis", async () => {
    const fetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).in("title", ["a,b", "c(d)", "plain", 3])
    expect(sentFilters(fetch)).toEqual(['title=in.("a,b","c(d)",plain,3)'])
  })
})

describe("MutationBuilder: the same filter set as QueryBuilder", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("update can filter with every query operator", async () => {
    const fetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "PATCH", { title: "x" })
      .gt("views", 1)
      .gte("likes", 2)
      .lt("rank", 3)
      .lte("score", 4)
      .like("title", "%a%")
      .ilike("body", "%B%")
      .is("deleted_at", null)
      .not("status", "eq", "draft")
      .or("owner.eq.1,owner.eq.2")
      .contains("tags", ["a"])
      .containedBy("meta", { k: 1 })
      .match({ author: "ann", lang: "en" })
    expect(sentFilters(fetch)).toEqual([
      "views=gt.1",
      "likes=gte.2",
      "rank=lt.3",
      "score=lte.4",
      "title=like.%a%",
      "body=ilike.%B%",
      "deleted_at=is.null",
      "status=not.eq.draft",
      "or=(owner.eq.1,owner.eq.2)",
      "tags=cs.{a}",
      'meta=cd.{"k":1}',
      "author=eq.ann",
      "lang=eq.en",
    ])
  })

  it("delete can filter with a range and a pattern", async () => {
    const fetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").lt("created_at", "2026-01-01").ilike("title", "tmp%")
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("DELETE")
    expect(sentFilters(fetch)).toEqual(["created_at=lt.2026-01-01", "title=ilike.tmp%"])
  })

  it("query and mutation produce identical filters for the same chain", async () => {
    const queryFetch = stubFetch()
    await new QueryBuilder<Post>(BASE, PATH, HEADERS).eq("a", 1).neq("b", 2).in("c", [3, 4]).match({ d: 5 })
    const query = sentFilters(queryFetch)
    vi.restoreAllMocks()
    const mutationFetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").eq("a", 1).neq("b", 2).in("c", [3, 4]).match({ d: 5 })
    expect(sentFilters(mutationFetch)).toEqual(query)
  })
})

describe("MutationBuilder: delete().select() returns the deleted rows", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("asks PostgREST for the representation once select() is called", async () => {
    const fetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").eq("id", "1").select("id")
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Prefer"]).toBe("return=representation")
  })

  it("a plain delete still asks for no body", async () => {
    const fetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "DELETE").eq("id", "1")
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Prefer"]).toBeUndefined()
  })

  it("an upsert keeps both preferences, without a stray comma", async () => {
    const fetch = stubFetch()
    await new MutationBuilder<Post>(BASE, PATH, HEADERS, "POST", { id: "1" }, { upsert: true }).select("id")
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Prefer"]).toBe("resolution=merge-duplicates,return=representation")
  })
})
