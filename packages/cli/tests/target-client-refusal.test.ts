import { afterEach, describe, expect, it, vi } from "vitest"
import { targetFetch, TargetApiError } from "../src/target-client.js"

afterEach(() => vi.unstubAllGlobals())

/** The error targetFetch throws for one answer from the server. */
async function refusedWith(answer: Response): Promise<TargetApiError> {
  vi.stubGlobal("fetch", () => Promise.resolve(answer))
  try {
    await targetFetch("https://api.example.test", "/platform/v1", { method: "POST", path: "/deploy", token: "t" })
  } catch (err) {
    if (err instanceof TargetApiError) return err
    throw err
  }
  throw new Error("the request was not refused")
}

// A refusal used to keep only a JSON body, so a plain-text or empty one showed `API error: 500 <url>`.
describe("a target refusal", () => {
  it("quotes a plain-text body, with the status", async () => {
    const err = await refusedWith(new Response("upstream exploded", { status: 500, statusText: "Internal Server Error" }))
    expect(err.message).toContain("HTTP 500 Internal Server Error: upstream exploded")
    expect(err.status).toBe(500)
  })

  it("says the body was empty", async () => {
    const err = await refusedWith(new Response("", { status: 502, statusText: "Bad Gateway" }))
    expect(err.message).toContain("HTTP 502 Bad Gateway, with an empty body")
  })

  it("names the JSON message when there is one", async () => {
    const err = await refusedWith(new Response(JSON.stringify({ message: "Schema drift", code: "DRIFT" }), { status: 409 }))
    expect(err.message).toContain("Schema drift")
    expect(err.message).toContain("HTTP 409")
    expect(err.code).toBe("DRIFT")
  })
})
