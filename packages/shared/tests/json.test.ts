import { describe, expect, expectTypeOf, it } from "vitest"
import {
  isArrayOf,
  isNumber,
  isOneOf,
  isShape,
  isString,
  nullable,
  optional,
  parseJsonObject,
  readJson,
  type JsonResponse,
} from "../src/json.js"

const isUser = isShape({
  id: isString,
  age: optional(isNumber),
  role: isOneOf(["admin", "member"] as const),
  manager: nullable(isString),
})

describe("isShape", () => {
  it("accepts an object whose named keys pass, and leaves an absent optional key absent", () => {
    const value: unknown = { id: "u1", role: "admin", manager: null, extra: true }
    expect(isUser(value)).toBe(true)
    if (isUser(value)) {
      expectTypeOf(value).toEqualTypeOf<
        { id: string; role: "admin" | "member"; manager: string | null } & { age?: number }
      >()
    }
  })

  it("refuses a wrong type, a missing required key, and anything not an object", () => {
    expect(isUser({ id: "u1", role: "owner", manager: null })).toBe(false)
    expect(isUser({ id: "u1", role: "admin" })).toBe(false)
    expect(isUser({ id: "u1", role: "admin", manager: null, age: "3" })).toBe(false)
    expect(isUser([{ id: "u1", role: "admin", manager: null }])).toBe(false)
    expect(isUser(null)).toBe(false)
  })
})

describe("isArrayOf", () => {
  it("needs every item to pass", () => {
    expect(isArrayOf(isString)(["a", "b"])).toBe(true)
    expect(isArrayOf(isString)(["a", 1])).toBe(false)
    expect(isArrayOf(isString)("a")).toBe(false)
  })
})

describe("parseJsonObject", () => {
  it("tells text that is not JSON from JSON that is not an object", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonObject("{a:1}")).toEqual({ ok: false, error: "not-json" })
    expect(parseJsonObject("[1]")).toEqual({ ok: false, error: "not-object" })
    expect(parseJsonObject("null")).toEqual({ ok: false, error: "not-object" })
  })
})

/** The parts of a fetch Response that readJson reads. */
function jsonResponse(body: unknown): JsonResponse {
  return { url: "http://x/u", status: 200, json: () => Promise.resolve(body) }
}

describe("readJson", () => {
  it("returns a body the guard accepts", async () => {
    const res = jsonResponse({ id: "u1", role: "member", manager: "u0" })
    await expect(readJson(res, isUser)).resolves.toEqual({ id: "u1", role: "member", manager: "u0" })
  })

  it("throws, with the status, on a body the guard refuses", async () => {
    const res = jsonResponse({ id: 1 })
    await expect(readJson(res, isUser)).rejects.toThrow(/Unexpected response .*HTTP 200/)
  })
})
