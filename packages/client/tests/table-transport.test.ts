import { describe, it, expect, vi, beforeEach } from "vitest"
import { createClient } from "../src/index.js"

const URL_BASE = "http://localhost:18473"

function rowsResponse(rows: unknown[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(rows),
    text: vi.fn().mockResolvedValue(JSON.stringify(rows)),
    headers: new Headers(),
  } as unknown as Response
}

/** A fetch that never answers, and gives up only when its signal is aborted. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted")
        err.name = "AbortError"
        reject(err)
      })
    }),
  )
}

function client(opts: { timeout?: number; retry?: boolean } = {}) {
  return createClient({ url: URL_BASE, anonKey: "anon", ...opts })
}

describe("config.timeout applies to table queries and mutations", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a select that never answers ends in a timeout error", { timeout: 2000 }, async () => {
    vi.stubGlobal("fetch", hangingFetch())
    const { data, error } = await client({ timeout: 50 }).from("posts").select("*")
    expect(data).toBeNull()
    expect(error?.code).toBe("NETWORK_TIMEOUT")
  })

  it("an insert that never answers ends in a timeout error", { timeout: 2000 }, async () => {
    vi.stubGlobal("fetch", hangingFetch())
    const { error } = await client({ timeout: 50 }).from("posts").insert({ title: "x", user_id: "u1" })
    expect(error?.code).toBe("NETWORK_TIMEOUT")
  })

  it("an update that never answers ends in a timeout error", { timeout: 2000 }, async () => {
    vi.stubGlobal("fetch", hangingFetch())
    const { error } = await client({ timeout: 50 }).from("posts").update({ title: "x" }).eq("id", 1)
    expect(error?.code).toBe("NETWORK_TIMEOUT")
  })
})

describe("config.retry applies to reads only", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a select retries a transient 503 and returns the rows", { timeout: 5000 }, async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(rowsResponse([], 503))
      .mockResolvedValueOnce(rowsResponse([{ id: 1 }]))
    vi.stubGlobal("fetch", fetch)
    const { data, error } = await client().from("posts").select("*")
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 1 }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("a select does not retry when retry is false", async () => {
    const fetch = vi.fn().mockResolvedValue(rowsResponse([], 503))
    vi.stubGlobal("fetch", fetch)
    const { error } = await client({ retry: false }).from("posts").select("*")
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("an insert is never retried, so a write the server may have applied is not repeated", async () => {
    const fetch = vi.fn().mockResolvedValue(rowsResponse([], 503))
    vi.stubGlobal("fetch", fetch)
    const { error } = await client().from("posts").insert({ title: "x", user_id: "u1" })
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("an insert is not retried after a network failure either", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    vi.stubGlobal("fetch", fetch)
    const { error } = await client().from("posts").insert({ title: "x", user_id: "u1" })
    expect(error).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("a rate-limited read keeps its 429 status", async () => {
    const fetch = vi.fn().mockResolvedValue(rowsResponse([], 429))
    vi.stubGlobal("fetch", fetch)
    const { error } = await client({ retry: false }).from("posts").select("*")
    expect(error?.status).toBe(429)
  })
})
