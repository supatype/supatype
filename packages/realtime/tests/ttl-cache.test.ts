import { describe, expect, it } from "vitest"
import { TtlCache } from "../src/ttl-cache.js"

describe("TtlCache", () => {
  it("shares one load between callers that miss the same key at once", async () => {
    const cache = new TtlCache<number>(60_000)
    let loads = 0
    const load = async (): Promise<number> => ++loads
    const values = await Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)])
    expect(values).toEqual([1, 1, 1])
    expect(loads).toBe(1)
  })

  it("forgets a failed load so the next caller tries again", async () => {
    const cache = new TtlCache<string>(60_000)
    await expect(cache.get("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down")
    expect(await cache.get("k", async () => "up")).toBe("up")
  })

  it("loads again once cleared", async () => {
    const cache = new TtlCache<number>(60_000)
    let loads = 0
    const load = async (): Promise<number> => ++loads
    await cache.get("k", load)
    cache.clear()
    expect(await cache.get("k", load)).toBe(2)
  })
})
