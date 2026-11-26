import { describe, expect, it, vi } from "vitest"

vi.mock("../src/dev-api-keys.js", () => ({
  configuredServiceRoleKey: () => "test-service-role-key",
}))

vi.mock("../src/resolve-api-url.js", () => ({
  resolveProjectApiUrl: () => "http://localhost:1234",
}))

describe("listRestCacheEntries", () => {
  it("coerces null entries to an empty array", async () => {
    const { listRestCacheEntries } = await import("../src/rest-cache-admin.js")

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ entries: null, cursor: "0" }), { status: 200 }),
    )

    try {
      const result = await listRestCacheEntries(process.cwd())
      expect(result.entries).toEqual([])
      expect(result.cursor).toBe("0")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * A SCAN page can be empty with more to come, so "no entries" is only true when the cursor says the
 * scan is over (S-25: native WSL said none while the server answered HIT).
 */
describe("listRestCacheEntries across empty pages", () => {
  const entry = { key: "k1", table: "fact", ttl_seconds: 20, size_bytes: 10 }

  const withPages = async (pages: Array<{ entries: unknown[]; cursor: string }>) => {
    const { listRestCacheEntries } = await import("../src/rest-cache-admin.js")
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    let next = 0
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      const page = pages[Math.min(next++, pages.length - 1)]
      return new Response(JSON.stringify(page), { status: 200 })
    })
    try {
      return { result: await listRestCacheEntries(process.cwd()), urls }
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it("follows the cursor past an empty page to the entries behind it", async () => {
    const { result, urls } = await withPages([
      { entries: [], cursor: "17" },
      { entries: [], cursor: "42" },
      { entries: [entry], cursor: "0" },
    ])
    expect(result.entries).toEqual([entry])
    expect(urls.map((u) => new URL(u).searchParams.get("cursor"))).toEqual([null, "17", "42"])
  })

  it("says there are none only once the cursor says the scan is over", async () => {
    const { result, urls } = await withPages([{ entries: [], cursor: "0" }])
    expect(result).toEqual({ entries: [], cursor: "0" })
    expect(urls).toHaveLength(1)
  })

  it("returns a page that has entries as it is, with its cursor", async () => {
    const { result, urls } = await withPages([{ entries: [entry], cursor: "9" }])
    expect(result.cursor).toBe("9")
    expect(urls).toHaveLength(1)
  })
})

/**
 * The server answers 503 with "keyspace not configured" now and "valkey not
 * configured" before the rename. A CLI is routinely newer than the deployment
 * it is pointed at, and older than one on a machine that has not updated,
 * so both have to land on the same explanation.
 */
describe("the message for a cache server that is not there", () => {
  const listAgainst = async (body: string) => {
    const { listRestCacheEntries } = await import("../src/rest-cache-admin.js")
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 503 }))
    try {
      return await listRestCacheEntries(process.cwd()).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it("explains either spelling without naming a product the user may not run", async () => {
    for (const body of ['{"error":"keyspace not configured"}', '{"error":"valkey not configured"}']) {
      const message = await listAgainst(body)
      expect(message).toContain("No cache server is configured")
      expect(message).toContain("supatype dev")
    }
  })

  it("does not claim that explanation for an unrelated 503", async () => {
    const message = await listAgainst('{"error":"upstream timeout"}')
    expect(message).not.toContain("No cache server is configured")
    expect(message).toContain("upstream timeout")
  })
})
