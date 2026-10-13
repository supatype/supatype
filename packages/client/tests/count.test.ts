import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryBuilder, parseContentRangeTotal } from "../src/query.js"

const BASE = "http://localhost:18473"
const PATH = "/rest/v1/posts"
const HEADERS: Record<string, string> = { apikey: "anon-key" }

/** PostgREST's answer, with the Content-Range it sends on every read. */
function stubRange(contentRange: string, rows: unknown[] = [{ id: 1 }, { id: 2 }], status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status,
    json: vi.fn().mockResolvedValue(rows),
    text: vi.fn().mockResolvedValue(JSON.stringify(rows)),
    headers: { get: (key: string) => (key.toLowerCase() === "content-range" ? contentRange : null) },
  }))
}

describe("count", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("is null when no count was asked for, though PostgREST sends `0-1/*`", async () => {
    stubRange("0-1/*")
    const { count, error } = await new QueryBuilder(BASE, PATH, HEADERS)
    expect(error).toBeNull()
    expect(count).toBeNull()
  })

  it("is null from maybeSingle when no count was asked for", async () => {
    stubRange("0-0/*", [{ id: 1 }])
    const { count } = await new QueryBuilder(BASE, PATH, HEADERS).maybeSingle()
    expect(count).toBeNull()
  })

  it("is the total when a count was asked for", async () => {
    stubRange("0-1/42", [{ id: 1 }, { id: 2 }], 206)
    const { count } = await new QueryBuilder(BASE, PATH, HEADERS, "*", undefined, undefined, { count: "exact" })
    expect(count).toBe(42)
  })

  it("is the total for an empty page, `*/0`", async () => {
    stubRange("*/0", [])
    const { count } = await new QueryBuilder(BASE, PATH, HEADERS, "*", undefined, undefined, { count: "exact" })
    expect(count).toBe(0)
  })
})

describe("parseContentRangeTotal", () => {
  it.each([
    ["0-24/3573458", 3573458],
    ["*/42", 42],
    ["0-1/*", null],
    ["*/*", null],
    ["garbage", null],
    ["0-1/12abc", null],
    [null, null],
  ])("%s -> %s", (header, expected) => {
    expect(parseContentRangeTotal(header)).toBe(expected)
  })
})
