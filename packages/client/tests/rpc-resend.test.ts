import { describe, it, expect, vi, beforeEach } from "vitest"
import { createClient } from "../src/index.js"

function respond(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as Response
}

describe("rpc: the resend after a 401 is the same request", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("keeps Content-Profile and Prefer on the second send", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(respond({ message: "JWT expired" }, 401))
      .mockResolvedValueOnce(respond(1, 200))
    vi.stubGlobal("fetch", fetch)
    const client = createClient({ url: "http://localhost:18473", anonKey: "anon", auth: { persistSession: false } })

    const { error } = await client.rpc("publish" as never, undefined, { schema: "supatype", count: "exact" })

    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit]>) {
      const headers = init.headers as Record<string, string>
      expect(headers["Content-Profile"]).toBe("supatype")
      expect(headers["Prefer"]).toBe("count=exact")
    }
  })
})
