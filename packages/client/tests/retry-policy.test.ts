import { describe, it, expect, vi, beforeEach } from "vitest"
import { fetchWithRetry } from "../src/fetch-with-retry.js"
import { createClient } from "../src/index.js"
import { fetchReturning, jsonResponse, type FetchMock, mockFetch } from "./support/fetch-mock.js"

const URL_BASE = "http://localhost:18473"

/** 503 once, then 200 with `body`. */
function flaky(body: unknown): FetchMock {
  const fetch = mockFetch()
    .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503))
    .mockImplementation(() => Promise.resolve(jsonResponse(body)))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** A fetch that never answers, and gives up only when its signal is aborted. */
function hanging(): FetchMock {
  const fetch = mockFetch((_input, init) =>
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
    vi.stubGlobal("fetch", fetchReturning({ msg: "slow down" }, 429))
    const res = await fetchWithRetry("http://api.test/x", { method: "POST" })
    expect(res.status).toBe(429)
  })
})

describe("rpc, graphql and functions: retried only when the call says it is idempotent", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("rpc is not retried by default", async () => {
    const fetch = flaky(1)
    const { error } = await client().rpc("do_thing")
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rpc with idempotent: true is retried", { timeout: 5000 }, async () => {
    const fetch = flaky(1)
    const { data, error } = await client().rpc("read_thing", undefined, { idempotent: true })
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
    await client().functions.invoke("fn")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("functions.invoke with idempotent: true is retried", { timeout: 5000 }, async () => {
    const fetch = flaky({ ok: true })
    const { error } = await client().functions.invoke("fn", { idempotent: true })
    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe("auth and storage use the client's transport", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a sign-in that never answers ends at the timeout", { timeout: 2000 }, async () => {
    hanging()
    await expect(
      client({ timeout: 50 }).auth.signInWithPassword({ email: "a@example.com", password: "pw" }),
    ).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" })
  })

  it("a sign-in is not retried after a 503", async () => {
    const fetch = flaky({})
    const { error } = await client().auth.signInWithPassword({ email: "a@example.com", password: "pw" })
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("a rate-limited sign-in returns the server's error rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({ code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" }, 429),
    )
    const { error } = await client().auth.signInWithPassword({ email: "a@example.com", password: "pw" })
    expect(error).toEqual({ message: "Request rate limit reached", status: 429, code: "over_request_rate_limit" })
  })

  it("a storage upload that never answers ends at the timeout", { timeout: 2000 }, async () => {
    hanging()
    await expect(
      client({ timeout: 50 }).storage.from("b").upload("f.txt", new Blob(["x"])),
    ).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" })
  })

  it("a storage download (GET) is retried after a 503", { timeout: 5000 }, async () => {
    const fetch = flaky({ ok: true })
    const { error } = await client().storage.from("b").download("f.txt")
    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("a storage list (a read sent as POST) is retried after a 503", { timeout: 5000 }, async () => {
    const fetch = flaky([])
    const { error } = await client().storage.from("b").list()
    expect(error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("a storage upload is not retried after a 503", async () => {
    const fetch = flaky({ Key: "b/f.txt" })
    const { error } = await client().storage.from("b").upload("f.txt", new Blob(["x"]))
    expect(error?.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
