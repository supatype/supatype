import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeployTarget } from "../src/resolve-target.js"
import { targetStream } from "../src/target-client.js"
import { targetStreamRequest } from "../src/target-request.js"

/**
 * Review of round 8, item C-6: a request built for a target with no token (a link resolved with
 * `tokenOptional`) sent `Authorization: Bearer undefined`. It sends no Authorization header.
 */
const target: DeployTarget = {
  mode: "self-host",
  environment: "production",
  projectRef: "acme",
  apiBaseUrl: "https://sh.example.test",
  apiPrefix: "/platform/v1",
  link: null,
}

afterEach(() => vi.unstubAllGlobals())

describe("a target request with no token", () => {
  it("sends no Authorization header", async () => {
    const sent: Headers[] = []
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers))
      return Promise.resolve(new Response("data: {}\n\n", { status: 200 }))
    })
    await targetStream(target.apiBaseUrl, "/admin/v1", targetStreamRequest(target, "/functions/logs/tail"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.has("Authorization")).toBe(false)
  })

  it("still sends the token when there is one", async () => {
    const sent: Headers[] = []
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers))
      return Promise.resolve(new Response("data: {}\n\n", { status: 200 }))
    })
    await targetStream(target.apiBaseUrl, "/admin/v1", targetStreamRequest({ ...target, token: "svc-key" }, "/functions/logs/tail"))
    expect(sent[0]?.get("Authorization")).toBe("Bearer svc-key")
  })
})
