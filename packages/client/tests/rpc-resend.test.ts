import { describe, it, expect, vi, beforeEach } from "vitest"
import { createClient } from "../src/index.js"
import { fetchCalls, header, jsonResponse, mockFetch } from "./support/fetch-mock.js"

describe("rpc: the resend after a 401 is the same request", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("keeps Content-Profile and Prefer on the second send", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(jsonResponse({ message: "JWT expired" }, 401))
      .mockResolvedValueOnce(jsonResponse(1, 200))
    vi.stubGlobal("fetch", fetch)
    const client = createClient({ url: "http://localhost:18473", anonKey: "anon", auth: { persistSession: false } })

    const { error } = await client.rpc("publish", undefined, { schema: "supatype", count: "exact" })

    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const { init } of fetchCalls(fetch)) {
      expect(header(init, "Content-Profile")).toBe("supatype")
      expect(header(init, "Prefer")).toBe("count=exact")
    }
  })
})
