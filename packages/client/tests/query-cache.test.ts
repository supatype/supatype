import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { QueryBuilder } from "../src/query.js"
import { QueryCache, buildCacheKey, identityFingerprint } from "../src/query-cache.js"

describe("query-cache", () => {
  it("identityFingerprint differs for different subs", () => {
    const payloadA = btoa(JSON.stringify({ sub: "a", role: "authenticated" }))
    const payloadB = btoa(JSON.stringify({ sub: "b", role: "authenticated" }))
    const a = identityFingerprint({ Authorization: `Bearer x.${payloadA}.y` }, "user")
    const b = identityFingerprint({ Authorization: `Bearer x.${payloadB}.y` }, "user")
    expect(a).not.toBe(b)
  })

  it("identityFingerprint stable for same sub across token strings", () => {
    const payload = btoa(JSON.stringify({ sub: "user-1", role: "authenticated" }))
    const a = identityFingerprint({ Authorization: `Bearer aaa.${payload}.sig1` }, "user")
    const b = identityFingerprint({ Authorization: `Bearer bbb.${payload}.sig2` }, "user")
    expect(a).toBe(b)
  })

  it("public scope uses global fingerprint", () => {
    expect(identityFingerprint({ Authorization: "Bearer x" }, "public")).toBe("global")
  })

  it("buildCacheKey is stable", () => {
    const h = { Authorization: "Bearer x" }
    const k1 = buildCacheKey("GET", "http://localhost/rest/v1/posts", h)
    const k2 = buildCacheKey("GET", "http://localhost/rest/v1/posts", h)
    expect(k1).toBe(k2)
  })

  it("QueryCache expires entries", () => {
    vi.useFakeTimers()
    const cache = new QueryCache()
    cache.set("k", { data: [{ id: 1 }], error: null, count: 1 }, 1000)
    expect(cache.get("k")?.data).toEqual([{ id: 1 }])
    vi.advanceTimersByTime(1001)
    expect(cache.get("k")).toBeNull()
    vi.useRealTimers()
  })
})

describe("QueryBuilder.cache", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns cached result without second fetch", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const cache = new QueryCache()
    const qb = new QueryBuilder<{ id: number }>(
      "http://localhost:9999",
      "/rest/v1/posts",
      { Authorization: "Bearer anon" },
      "*",
      cache,
    ).cache({ ttl: 60_000 })

    const r1 = await qb
    expect(r1.data).toEqual([{ id: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const r2 = await qb
    expect(r2.data).toEqual([{ id: 1 }])
    expect(r2.meta?.cacheStatus).toBe("HIT")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends X-Supatype-Cache when server: true", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Supatype-Cache-Status": "MISS",
        },
      }),
    )

    await new QueryBuilder("http://localhost:9999", "/rest/v1/posts", {}, "*")
      .cache({ ttl: 30_000, server: true })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toMatchObject({ "X-Supatype-Cache": "max-age=30" })
  })

  it("sends public directive when server and public", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    )

    await new QueryBuilder("http://localhost:9999", "/rest/v1/posts", {}, "*")
      .cache({ ttl: 30_000, server: true, public: true })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toMatchObject({ "X-Supatype-Cache": "max-age=30, public" })
  })
})
