import { describe, expect, it, vi, afterEach } from "vitest"
import { targetFetch, TargetApiError } from "../src/target-client.js"

describe("targetFetch cloud auth refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("refreshes once on TOKEN_EXPIRED then retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: "Token expired", code: "TOKEN_EXPIRED" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { ok: true } }),
      })

    vi.stubGlobal("fetch", fetchMock)

    const onRefreshed = vi.fn()
    const result = await targetFetch<{ ok: boolean }>("http://api.test", "/api/v1", {
      method: "GET",
      path: "/projects/x/status",
      token: "old-access",
      authRefresh: {
        cloudApiUrl: "http://api.test",
        refreshToken: "old-refresh",
        onRefreshed,
      },
    })

    expect(result).toEqual({ ok: true })
    expect(onRefreshed).toHaveBeenCalledWith({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryAuth = (fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>
    expect(retryAuth.Authorization).toBe("Bearer new-access")
  })

  it("points to supatype login when expired without refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Token expired", code: "TOKEN_EXPIRED" }),
      }),
    )

    await expect(
      targetFetch("http://api.test", "/api/v1", {
        method: "GET",
        path: "/projects/x/status",
        token: "old",
      }),
    ).rejects.toThrow(/supatype login/)
  })

  it("throws TargetApiError with status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "boom" }),
      }),
    )

    await expect(
      targetFetch("http://api.test", "/api/v1", {
        method: "GET",
        path: "/x",
        token: "t",
      }),
    ).rejects.toMatchObject({ name: "TargetApiError", status: 500 } satisfies Partial<TargetApiError>)
  })
})
