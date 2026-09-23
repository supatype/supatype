import { describe, expect, it, vi } from "vitest"

vi.mock("../src/env-file.js", () => ({
  readEnvValue: () => "test-service-role-key",
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
 * The server answers 503 with "keyspace not configured" now and "valkey not
 * configured" before the rename. A CLI is routinely newer than the deployment
 * it is pointed at — and older than one, on a machine that has not updated —
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
