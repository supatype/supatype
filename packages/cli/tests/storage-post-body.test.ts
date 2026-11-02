import { afterEach, describe, expect, it, vi } from "vitest"
import { postToStorage } from "../src/storage-provision.js"

afterEach(() => vi.unstubAllGlobals())

describe("postToStorage", () => {
  // An imported object can be large; the bytes read from disk go to fetch as they are, not copied.
  it("sends a file's bytes as given, without a copy", async () => {
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      bodies.push(init.body)
      return Promise.resolve(new Response(null, { status: 200 }))
    })
    const bytes = Buffer.from("object bytes")
    await postToStorage("http://storage.test/object/b/a.txt", {}, bytes)
    expect(bodies[0]).toBe(bytes)
  })
})
