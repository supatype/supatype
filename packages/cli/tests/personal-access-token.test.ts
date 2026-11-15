import { afterEach, describe, expect, it, vi } from "vitest"
import { isPersonalAccessToken } from "../src/personal-access-token.js"
import { targetFetch } from "../src/target-client.js"

const PAT = `spt_${"a1".repeat(20)}`

afterEach(() => vi.unstubAllGlobals())

describe("a stored personal access token", () => {
  it("is recognised by its spt_ plus 40 hex shape and nothing else", () => {
    expect(isPersonalAccessToken(PAT)).toBe(true)
    expect(isPersonalAccessToken("spt_short")).toBe(false)
    expect(isPersonalAccessToken("eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBe(false)
  })

  it("is never renewed through /auth/refresh when the control plane refuses it", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ error: "invalid_token", code: "INVALID_TOKEN" }), { status: 401 })
    })
    const onRefreshed = vi.fn()
    await expect(
      targetFetch("http://cp.test", "/api/v1", {
        method: "GET",
        path: "/projects",
        token: PAT,
        authRefresh: { cloudApiUrl: "http://cp.test", refreshToken: "r", onRefreshed },
      }),
    ).rejects.toThrow()
    expect(calls.some((url) => url.endsWith("/auth/refresh"))).toBe(false)
    expect(onRefreshed).not.toHaveBeenCalled()
  })

  it("still renews an old session token that expired", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url)
      if (url.endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ access_token: "new-jwt", refresh_token: "r2" }), { status: 200 })
      }
      return calls.length === 1
        ? new Response(JSON.stringify({ code: "TOKEN_EXPIRED" }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const onRefreshed = vi.fn()
    await targetFetch("http://cp.test", "/api/v1", {
      method: "GET",
      path: "/projects",
      token: "old.session.jwt",
      authRefresh: { cloudApiUrl: "http://cp.test", refreshToken: "r", onRefreshed },
    })
    expect(onRefreshed).toHaveBeenCalledWith({ accessToken: "new-jwt", refreshToken: "r2" })
  })
})

describe("what counts as the control plane refusing a token", () => {
  it("is the exact invalid_token error, not a message that merely mentions it", async () => {
    const answers = [
      new Response(JSON.stringify({ message: "field invalid_token_hint is wrong" }), { status: 401 }),
    ]
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url)
      return answers.shift() ?? new Response("{}", { status: 500 })
    })
    const onRefreshed = vi.fn()
    await expect(
      targetFetch("http://cp.test", "/api/v1", {
        method: "GET",
        path: "/projects",
        token: "old.session.jwt",
        authRefresh: { cloudApiUrl: "http://cp.test", refreshToken: "r", onRefreshed },
      }),
    ).rejects.toThrow()
    expect(calls.some((url) => url.endsWith("/auth/refresh"))).toBe(false)
  })
})
