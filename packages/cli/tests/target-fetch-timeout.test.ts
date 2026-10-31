import { afterEach, describe, expect, it, vi } from "vitest"
import { targetFetch } from "../src/target-client.js"

/**
 * Review of round 5: the functions commands moved onto targetFetch, which had no timeout, so list,
 * delete, env and the Cloud log window waited forever on a target that never answered. Each had
 * given up after 10 s (deploy 60 s) before.
 */
afterEach(() => {
  vi.unstubAllGlobals()
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
