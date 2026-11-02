import { afterEach, describe, expect, it, vi } from "vitest"
import { targetFetch, targetStream } from "../src/target-client.js"

/**
 * Review of round 5: the functions commands moved onto targetFetch, which had no timeout, so list,
 * delete, env and the Cloud log window waited forever on a target that never answered. Each had
 * given up after 10 s (deploy 60 s) before.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A target that accepts the connection and never answers, until the request is aborted. */
function stalledTarget(): void {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  }))
}

describe("targetFetch against a target that never answers", () => {
  it("gives up after the call's timeout, saying where and how long it waited", async () => {
    stalledTarget()
    const call = targetFetch("https://sh.example.test", "/platform/v1", {
      method: "GET",
      path: "/projects/acme/functions",
      token: "svc-key",
      timeoutMs: 50,
    })
    await expect(call).rejects.toThrow("GET https://sh.example.test/platform/v1/projects/acme/functions did not answer within 0.05 s")
  }, 2000)
})

/** A Cloud request answered 401 TOKEN_EXPIRED, then the refresh and the resend as `answer` says. */
function expiringSession(answer: { refreshMs: number | "never"; resendMs: number; firstMs?: number }): void {
  let calls = 0
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls++
    if (String(url).endsWith("/auth/refresh")) {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        if (answer.refreshMs !== "never") {
          setTimeout(() => resolve(new Response(JSON.stringify({ access_token: "fresh" }))), answer.refreshMs)
        }
      })
    }
    if (calls === 1) {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        setTimeout(() => resolve(new Response(JSON.stringify({ code: "TOKEN_EXPIRED" }), { status: 401 })), answer.firstMs ?? 0)
      })
    }
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      setTimeout(() => resolve(new Response(JSON.stringify({ data: ["ok"] }))), answer.resendMs)
    })
  })
}

const expiredRequest = (timeoutMs: number) => targetFetch("https://api.example.test", "/api/v1", {
  method: "GET",
  path: "/projects/acme/functions",
  token: "old",
  timeoutMs,
  authRefresh: { cloudApiUrl: "https://api.example.test", refreshToken: "r", onRefreshed: () => undefined },
})

// Review of round 5: the session refresh had no timeout, and its time came out of the request's.
describe("a Cloud session renewed during a request", () => {
  it("says the refresh did not answer when it stalls", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => real(Math.min(ms, 100)))
    expiringSession({ refreshMs: "never", resendMs: 0 })
    await expect(expiredRequest(5_000)).rejects.toThrow(/refresh.*did not answer/i)
  }, 3000)

  // Review of round 5: each send had the whole limit, so a renewed request could take twice it.
  it("gives both sends one limit between them, the renewal apart", async () => {
    expiringSession({ firstMs: 200, refreshMs: 0, resendMs: 200 })
    await expect(expiredRequest(300)).rejects.toThrow("did not answer within 0.3 s")
  }, 3000)

  it("gives the resent request its own time, not what the refresh left of it", async () => {
    expiringSession({ refreshMs: 250, resendMs: 100 })
    await expect(expiredRequest(300)).resolves.toEqual(["ok"])
  }, 3000)
})

// Review of round 5: a stream given a time limit was cut off mid-stream when it ran out. The limit
// covers the wait for the answer to start, never the body.
describe("targetStream with a time limit", () => {
  it("keeps streaming past the limit once the answer has started", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late line"))
            controller.close()
          }, 300)
        },
      })
      return Promise.resolve(new Response(body))
    })
    const stream = await targetStream("https://sh.example.test", "/admin/v1", { method: "GET", path: "/functions/logs/tail", token: "k", timeoutMs: 100 })
    expect(await new Response(stream).text()).toBe("late line")
  }, 3000)

  it("gives up when the answer does not start within the limit", async () => {
    stalledTarget()
    const stream = targetStream("https://sh.example.test", "/admin/v1", { method: "GET", path: "/functions/logs/tail", token: "k", timeoutMs: 50 })
    await expect(stream).rejects.toThrow("GET https://sh.example.test/admin/v1/functions/logs/tail did not answer within 0.05 s")
  }, 3000)
})
