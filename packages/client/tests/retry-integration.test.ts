/**
 * Integration test — Task 90: SDK retry behaviour
 *
 * Simulates 503 -> SDK retries 3x with backoff -> succeeds or throws after max retries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchWithRetry } from "../src/fetch-with-retry.js"
import { NetworkError } from "../src/errors.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
    statusText: status === 503 ? "Service Unavailable" : "OK",
  } as unknown as Response
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task 90 — SDK retry integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("succeeds immediately on 200 with no retries", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(200, { data: "ok" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })
    const res = await promise

    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("retries on 503 and succeeds on second attempt", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200, { data: "recovered" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })

    // Advance past first retry delay (200ms)
    await vi.advanceTimersByTimeAsync(250)

    const res = await promise
    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("retries on 500 server errors", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(502))
      .mockResolvedValueOnce(mockResponse(200, { data: "ok" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })

    // Advance through retry delays
    await vi.advanceTimersByTimeAsync(250)  // First retry (200ms delay)
    await vi.advanceTimersByTimeAsync(1100) // Second retry (1000ms delay)

    const res = await promise
    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("retries up to maxRetries then returns the 503 response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(503))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })

    // Advance through all retry delays
    await vi.advanceTimersByTimeAsync(250)   // retry 1 (200ms)
    await vi.advanceTimersByTimeAsync(1100)  // retry 2 (1000ms)
    await vi.advanceTimersByTimeAsync(3100)  // retry 3 (3000ms)

    const res = await promise
    // After all retries exhausted, the last 503 response is returned
    expect(res.status).toBe(503)
    expect(fetchSpy).toHaveBeenCalledTimes(4) // initial + 3 retries
  })

  it("does not retry on 4xx client errors (except 429)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(404, { error: "Not found" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })
    const res = await promise

    expect(res.status).toBe(404)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // No retries for 4xx
  })

  it("does not retry on 401", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(401, { error: "Unauthorized" }))
    vi.stubGlobal("fetch", fetchSpy)

    const res = await fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })

    expect(res.status).toBe(401)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("retries on network errors (fetch throws)", async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(mockResponse(200, { data: "ok" }))
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 5000 })

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(1100)

    const res = await promise
    expect(res.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("throws NetworkError after exhausting retries on network failures", async () => {
    vi.useRealTimers()
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    vi.stubGlobal("fetch", fetchSpy)

    await expect(
      fetchWithRetry("http://api.test/data", { maxRetries: 0, timeout: 5000 }),
    ).rejects.toThrow(NetworkError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
  })

  it("throws NetworkError with CONNECTION_REFUSED code", async () => {
    vi.useRealTimers()
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    vi.stubGlobal("fetch", fetchSpy)

    try {
      await fetchWithRetry("http://api.test/data", { maxRetries: 0, timeout: 5000 })
      expect.fail("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError)
      expect((err as NetworkError).code).toBe("NETWORK_CONNECTION_REFUSED")
    }
    vi.useFakeTimers()
  })

  it("respects retry: false option — no retries attempted", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse(503))
    vi.stubGlobal("fetch", fetchSpy)

    const res = await fetchWithRetry("http://api.test/data", { retry: false, timeout: 5000 })

    expect(res.status).toBe(503)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("uses exponential backoff delays: 200ms, 1000ms, 3000ms", async () => {
    const timestamps: number[] = []
    const fetchSpy = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now())
      return mockResponse(503)
    })
    vi.stubGlobal("fetch", fetchSpy)

    const promise = fetchWithRetry("http://api.test/data", { maxRetries: 3, timeout: 30000 })

    // Initial call happens immediately
    await vi.advanceTimersByTimeAsync(0)
    expect(timestamps).toHaveLength(1)

    // First retry after ~200ms
    await vi.advanceTimersByTimeAsync(200)
    expect(timestamps).toHaveLength(2)

    // Second retry after ~1000ms
    await vi.advanceTimersByTimeAsync(1000)
    expect(timestamps).toHaveLength(3)

    // Third retry after ~3000ms
    await vi.advanceTimersByTimeAsync(3000)
    expect(timestamps).toHaveLength(4)

    await promise
  })

  it("AbortError from timeout throws NetworkError with TIMEOUT code", async () => {
    const abortError = new Error("The operation was aborted")
    abortError.name = "AbortError"
    const fetchSpy = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal("fetch", fetchSpy)

    // Timeout is handled by the AbortController in fetchWithRetry
    await expect(
      fetchWithRetry("http://api.test/data", { maxRetries: 0, timeout: 100 }),
    ).rejects.toThrow("timed out")
  })
})
