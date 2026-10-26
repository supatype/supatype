import { describe, expect, expectTypeOf, it } from "vitest"
import {
  bodyErrorText,
  isArrayOf,
  isNumber,
  isOneOf,
  isShape,
  isString,
  nullable,
  optional,
  parseJsonObject,
  readJson,
} from "../src/lib/json.js"

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

describe("readJson", () => {
  it("returns a body the guard accepts", async () => {
    const res = new Response(JSON.stringify({ id: "u1", role: "member", manager: "u0" }))
    await expect(readJson(res, isUser)).resolves.toEqual({ id: "u1", role: "member", manager: "u0" })
  })

  it("throws, with the status, on a body the guard refuses", async () => {
    const res = new Response(JSON.stringify({ id: 1 }), { status: 200 })
    await expect(readJson(res, isUser)).rejects.toThrow(/Unexpected response .*HTTP 200/)
  })
})

describe("bodyErrorText", () => {
  // A Studio API refusal carries a code in `error` and the sentence in `message`. An older server put
  // the sentence in `error` alone, so that is read when there is no `message`.
  it.each([
    ["the sentence, not the code", { error: "forbidden", message: "Studio role \"viewer\" cannot perform this request" }, "Studio role \"viewer\" cannot perform this request"],
    ["the sentence an older server put in error", { error: "Authentication required" }, "Authentication required"],
    ["nothing from a body with no sentence", { code: 403 }, undefined],
  ])("reads %s", (_, body, sentence) => {
    expect(bodyErrorText(body)).toBe(sentence)
  })
})
