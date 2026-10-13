import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchWithRetry } from "../src/fetch-with-retry.js"
import { createClient } from "../src/index.js"

const URL_BASE = "http://localhost:18473"

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    blob: vi.fn().mockResolvedValue(new Blob([JSON.stringify(body)])),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response
}

/** 503 once, then 200 with `body`. */
function flaky(body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn()
    .mockResolvedValueOnce(respond({ message: "unavailable" }, 503))
    .mockResolvedValue(respond(body))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** A fetch that never answers, and gives up only when its signal is aborted. */
function hanging(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted")
        err.name = "AbortError"
        reject(err)
      })
    }),
  )
  vi.stubGlobal("fetch", fetch)
  return fetch
}

function client(opts: { timeout?: number } = {}) {
  return createClient({ url: URL_BASE, anonKey: "anon", auth: { persistSession: false }, ...opts })
}

describe("fetchWithRetry retries only GET and HEAD unless the call opts in", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a POST that fails with a 503 is sent once", async () => {
    const fetch = flaky({ ok: true })
    const res = await fetchWithRetry("http://api.test/x", { method: "POST", body: "{}" })
    expect(res.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("a POST the caller marks idempotent is retried", { timeout: 5000 }, async () => {
    const fetch = flaky({ ok: true })
    const res = await fetchWithRetry("http://api.test/x", { method: "POST", body: "{}", idempotent: true })
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("a GET is retried", { timeout: 5000 }, async () => {
    const fetch = flaky({ ok: true })
    const res = await fetchWithRetry("http://api.test/x")
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("a 429 on a request that may not be retried comes back as the response, not a throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ msg: "slow down" }, 429)))
    const res = await fetchWithRetry("http://api.test/x", { method: "POST" })
    expect(res.status).toBe(429)
  })
})

describe("rpc, graphql and functions: retried only when the call says it is idempotent", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("rpc is not retried by default", async () => {
    const fetch = flaky(1)
    const { error } = await client().rpc("do_thing" as never)
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rpc with idempotent: true is retried", { timeout: 5000 }, async () => {
    const fetch = flaky(1)
    const { data, error } = await client().rpc("read_thing" as never, undefined, { idempotent: true })
    expect(error).toBeNull()
    expect(data).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("graphql is not retried by default", async () => {
    const fetch = flaky({ data: {} })
    await client().graphql("{ a }")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("graphql with idempotent: true is retried", { timeout: 5000 }, async () => {
    const fetch = flaky({ data: { a: 1 } })
    const { data, error } = await client().graphql("{ a }", undefined, { idempotent: true })
    expect(error).toBeNull()
    expect(data).toEqual({ a: 1 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("functions.invoke (POST) is not retried by default", async () => {
    const fetch = flaky({ ok: true })
    await client().functions.invoke("fn" as never)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("functions.invoke with idempotent: true is retried", { timeout: 5000 }, async () => {
    const fetch = flaky({ ok: true })
    const { error } = await client().functions.invoke("fn" as never, { idempotent: true })
    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
