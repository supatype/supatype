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
