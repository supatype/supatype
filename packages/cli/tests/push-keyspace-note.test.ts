import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/dev-api-keys.js", () => ({
  configuredServiceRoleKey: () => "test-service-role-key",
}))
vi.mock("../src/resolve-api-url.js", () => ({
  resolveProjectApiUrl: () => "http://localhost:1234",
}))

/**
 * A push declared a cache and said nothing when the server had no keyspace to cache in: every
 * `.cache({ server: true })` read then answered BYPASS (FF-8). A push now asks the server's
 * `/admin/v1/cache` and says so. It says nothing when it cannot tell, or when nothing declares a cache.
 */
const declaring = (...tables: string[]) => ({
  models: tables.map((table) => ({
    name: table,
    annotations: { db: { tableName: table }, platform: { cache: { enabled: true } } },
  })),
})

const original = globalThis.fetch
let asked: string[] = []

function serverAnswers(status: number, body: string): void {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    asked.push(String(url))
    return new Response(body, { status })
  }) as typeof fetch
}

beforeEach(() => {
  asked = []
})
afterEach(() => {
  globalThis.fetch = original
})

describe("keyspaceConnected", () => {
  it("is true when the cache route answers", async () => {
    const { keyspaceConnected } = await import("../src/rest-cache-admin.js")
    serverAnswers(200, JSON.stringify({ entries: [], cursor: "0" }))
    expect(await keyspaceConnected(process.cwd())).toBe(true)
    expect(asked[0]).toContain("/admin/v1/cache")
  })

  it.each([["keyspace not configured"], ["valkey not configured"]])("is false when the server says %s", async (body) => {
    const { keyspaceConnected } = await import("../src/rest-cache-admin.js")
    serverAnswers(503, JSON.stringify({ error: body }))
    expect(await keyspaceConnected(process.cwd())).toBe(false)
  })

  it("is unknown when the plan does not offer the cache, or the server cannot be reached", async () => {
    const { keyspaceConnected } = await import("../src/rest-cache-admin.js")
    serverAnswers(403, JSON.stringify({ error: "rest_cache_not_available" }))
    expect(await keyspaceConnected(process.cwd())).toBeNull()
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    expect(await keyspaceConnected(process.cwd())).toBeNull()
  })
})

describe("the push note about a missing keyspace", () => {
  it("names the declared tables and where to look when no keyspace is connected", async () => {
    const { cacheKeyspaceNotes } = await import("../src/api-config-cache.js")
    serverAnswers(503, JSON.stringify({ error: "keyspace not configured" }))
    const [note, ...rest] = await cacheKeyspaceNotes(process.cwd(), declaring("posts", "tags"))
    expect(rest).toEqual([])
    expect(note).toContain("No keyspace is connected")
    expect(note).toContain("posts, tags")
    expect(note).toContain("`valkey`")
  })

  it("says nothing when a keyspace is connected", async () => {
    const { cacheKeyspaceNotes } = await import("../src/api-config-cache.js")
    serverAnswers(200, JSON.stringify({ entries: [], cursor: "0" }))
    expect(await cacheKeyspaceNotes(process.cwd(), declaring("posts"))).toEqual([])
  })

  it("does not ask the server when nothing declares a cache", async () => {
    const { cacheKeyspaceNotes } = await import("../src/api-config-cache.js")
    serverAnswers(503, JSON.stringify({ error: "keyspace not configured" }))
    expect(await cacheKeyspaceNotes(process.cwd(), { models: [] })).toEqual([])
    expect(asked).toEqual([])
  })

  it("says nothing when it cannot tell", async () => {
    const { cacheKeyspaceNotes } = await import("../src/api-config-cache.js")
    serverAnswers(403, JSON.stringify({ error: "rest_cache_not_available" }))
    expect(await cacheKeyspaceNotes(process.cwd(), declaring("posts"))).toEqual([])
  })
})
