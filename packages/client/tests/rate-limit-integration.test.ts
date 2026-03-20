/**
 * Integration test — Task 91: SDK rate limit handling
 *
 * Simulates 429 with Retry-After: 2 -> SDK waits -> retries -> succeeds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchWithRetry } from "../src/fetch-with-retry.js"
import { RateLimitError } from "../src/errors.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse(status: number, body: unknown = {}, headers?: Record<string, string>): Response {
  const headersObj = new Headers(headers)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: headersObj,
    statusText: status === 429 ? "Too Many Requests" : "OK",
  } as unknown as Response
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task 91 — SDK rate limit integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("waits Retry-After seconds then retries on 429", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mockResponse(429, { error: "rate limited" }, { "Retry-After": "2" }))
      .mockResolvedValueOnce(mockResponse(200, { data: "success" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 10000 })

    // First call returns 429 with Retry-After: 2
    // SDK should wait 2000ms before retrying
    await vi.advanceTimersByTimeAsync(2100)

    const res = await promise
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("uses Retry-After header value for wait duration", async () => {
    const timestamps: number[] = []
    const fetchSpy = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now())
      if (timestamps.length === 1) {
        return mockResponse(429, {}, { "Retry-After": "3" })
      }
      return mockResponse(200, { data: "ok" })
    })
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 10000 })

    // Should not retry before 3 seconds
    await vi.advanceTimersByTimeAsync(2900)
    expect(timestamps).toHaveLength(1) // Only the first call

    // After 3 seconds, retry should fire
    await vi.advanceTimersByTimeAsync(200)
    const res = await promise

    expect(res.ok).toBe(true)
    expect(timestamps).toHaveLength(2)
    // The gap between timestamps should be ~3000ms
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(3000)
  })

  it("defaults to 5 seconds when Retry-After header is missing", async () => {
    const timestamps: number[] = []
    const fetchSpy = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now())
      if (timestamps.length === 1) {
        return mockResponse(429, {}) // No Retry-After header
      }
      return mockResponse(200, { data: "ok" })
    })
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 30000 })

    await vi.advanceTimersByTimeAsync(5100)
    const res = await promise

    expect(res.ok).toBe(true)
    expect(timestamps).toHaveLength(2)
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(5000)
  })

  it("throws RateLimitError after exhausting all retries on 429", async () => {
    vi.useRealTimers()
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse(429, { error: "rate limited" }, { "Retry-After": "1" }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    // Use maxRetries: 0 to avoid actual wait times and still test the throw
    await expect(
      fetchWithRetry("http://api.test/data", { maxRetries: 0, timeout: 30000 }),
    ).rejects.toThrow(RateLimitError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
  })

  it("RateLimitError includes retryAfterSeconds", async () => {
    vi.useRealTimers()
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse(429, {}, { "Retry-After": "2" }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    try {
      await fetchWithRetry("http://api.test/data", { maxRetries: 0, timeout: 30000 })
      expect.fail("Should have thrown RateLimitError")
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError)
      expect((err as RateLimitError).retryAfterSeconds).toBe(2)
      expect((err as RateLimitError).statusCode).toBe(429)
      expect((err as RateLimitError).code).toBe("RATE_LIMITED")
    }
    vi.useFakeTimers()
  })

  it("handles mixed 429 then 503 then 200", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mockResponse(429, {}, { "Retry-After": "1" }))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200, { data: "finally" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 30000 })

    // Wait for 429 retry (1s)
    await vi.advanceTimersByTimeAsync(1100)
    // Wait for 503 retry (1000ms — second retry delay)
    await vi.advanceTimersByTimeAsync(1100)

    const res = await promise
    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("429 is not retried when retry: false", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockResponse(429, {}, { "Retry-After": "2" }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    // With retry: false, maxRetries becomes 0
    await expect(
      fetchWithRetry("http://api.test/data", { retry: false, timeout: 5000 }),
    ).rejects.toThrow(RateLimitError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("succeeds after one 429 retry with correct response data", async () => {
    const expectedData = { users: [{ id: 1, name: "Alice" }], total: 1 }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mockResponse(429, {}, { "Retry-After": "1" }))
      .mockResolvedValueOnce(mockResponse(200, expectedData))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/users", { maxRetries: 3, timeout: 10000 })

    await vi.advanceTimersByTimeAsync(1100)

    const res = await promise
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toEqual(expectedData)
  })
})
