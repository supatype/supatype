import { afterEach, describe, expect, it, vi } from "vitest"
import { targetFetch } from "../src/target-client.js"

afterEach(() => vi.unstubAllGlobals())

/** Node's rejection for a request that never got an answer: `fetch failed`, the reason in `cause`. */
function nodeFailure(code: string, message: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) })
}

async function failureOf(rejection: Error): Promise<Error> {
  vi.stubGlobal("fetch", () => Promise.reject(rejection))
  try {
    await targetFetch("http://api.nope.test:18680", "/api/v1", { method: "GET", path: "/projects", token: "t" })
  } catch (err) {
    if (err instanceof Error) return err
    throw err
  }
  throw new Error("the request did not fail")
}

// A Cloud command that could not reach the API said only "[supatype] fetch failed".
describe("a Cloud request that gets no answer", () => {
  it("names the URL and the reason in the cause", async () => {
    const err = await failureOf(nodeFailure("ENOTFOUND", "getaddrinfo ENOTFOUND api.nope.test"))
    expect(err.message).toContain("http://api.nope.test:18680/api/v1/projects")
    expect(err.message).toContain("getaddrinfo ENOTFOUND api.nope.test")
    expect(err.message).not.toBe("fetch failed")
  })

  it("names the URL for a failure whose cause has no message of its own", async () => {
    const cause = Object.assign(new Error(""), { code: "ETIMEDOUT" })
    const err = await failureOf(new TypeError("fetch failed", { cause }))
    expect(err.message).toContain("http://api.nope.test:18680/api/v1/projects")
    expect(err.message).toContain("connection timed out")
  })

  it("still names the URL when the failure has no cause", async () => {
    const err = await failureOf(new TypeError("fetch failed"))
    expect(err.message).toContain("http://api.nope.test:18680/api/v1/projects")
  })

  it("keeps the original error as its cause", async () => {
    const original = nodeFailure("ECONNRESET", "read ECONNRESET")
    expect((await failureOf(original)).cause).toBe(original)
  })
})
