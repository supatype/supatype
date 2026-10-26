/**
 * `headers` may be a function, read on every request, so a header can change for the life of one
 * client. Studio's acting-mode switch needs this: the mode a request asks for is chosen after the
 * client exists, and rebuilding the client would drop its session and its sockets.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../src/index.js"

const BASE = "http://localhost:18474"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test"

afterEach(() => {
  vi.unstubAllGlobals()
})

function captureRequests(): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = []
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) })
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  })
  return seen
}

describe("headers", () => {
  it("are read on every request when given as a function", async () => {
    const seen = captureRequests()
    let mode = "elevated"
    const client = createClient({ url: BASE, anonKey: ANON_KEY, headers: () => ({ "X-Supatype-Acting-Mode": mode }) })

    await client.from("posts").select()
    mode = "self"
    await client.from("posts").select()

    expect(seen.map((h) => h["X-Supatype-Acting-Mode"])).toEqual(["elevated", "self"])
  })

  it("are still sent when given as a plain object", async () => {
    const seen = captureRequests()
    const client = createClient({ url: BASE, anonKey: ANON_KEY, headers: { "X-Supatype-Environment": "staging" } })
    await client.from("posts").select()
    expect(seen[0]?.["X-Supatype-Environment"]).toBe("staging")
  })
})
