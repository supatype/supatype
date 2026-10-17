/**
 * Exact-value columns surviving the trip through `JSON.parse`.
 *
 * Postgres holds 9007199254740993 and PostgREST puts those digits on the wire as an unquoted JSON
 * number. `JSON.parse` returns 9007199254740992. The digits are correct right up until the client
 * reads them, so the fix has to happen on the response text, before any parse.
 *
 * Both `money` and `decimal` are NUMERIC and both are declared `string` by the generator, so they
 * share the `numeric` kind here. `bigInt` is declared `bigint` and becomes a native one.
 */
import { describe, expect, it } from "vitest"
import {
  quoteExactNumbers,
  coerceExactKinds,
  findLossyNumbers,
  stringifyWithBigInts,
  type ExactFields,
} from "../src/exact-values.js"

const fields: ExactFields = { views: "bigint", price: "numeric", balance: "numeric" }

describe("quoteExactNumbers", () => {
  it("keeps a bigint past 2^53 that JSON.parse would round", () => {
    const body = '[{"views":9007199254740993}]'
    // The failure this exists to prevent, stated as an assertion.
    const lossy = JSON.parse(body)
    expect(lossy).toEqual([{ views: 9007199254740992 }])

    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual([{ views: "9007199254740993" }])
  })

  it("keeps a high-precision decimal", () => {
    const body = '[{"price":12345678901234567890.1234}]'
    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual([{ price: "12345678901234567890.1234" }])
  })

  it("keeps trailing zeros on a money amount", () => {
    // Not a value loss, but `19.0000` becoming `19` contradicts the declared `string` type.
    const body = '[{"balance":19.0000}]'
    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual([{ balance: "19.0000" }])
  })

  it("leaves columns that are not exact-value kinds alone", () => {
    const body = '[{"hits":42,"rate":1.5}]'
    expect(quoteExactNumbers(body, fields)).toBe(body)
  })

  it("leaves null alone", () => {
    const body = '[{"views":null}]'
    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual([{ views: null }])
  })

  it("leaves a value that is already a string alone", () => {
    const body = '[{"views":"9007199254740993"}]'
    expect(quoteExactNumbers(body, fields)).toBe(body)
  })

  it("does not rewrite a field name that appears inside a string value", () => {
    // The hazard that makes a regex wrong: this is prose, not a column.
    const body = '[{"title":"the \\"views\\":123 column","hits":7}]'
    expect(quoteExactNumbers(body, fields)).toBe(body)
  })

  it("handles negative and exponent literals", () => {
    const body = '[{"views":-9007199254740993,"price":1.5e10}]'
    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual([{ views: "-9007199254740993", price: "1.5e10" }])
  })

  it("handles a single-object response as well as an array", () => {
    const body = '{"views":9007199254740993}'
    expect(JSON.parse(quoteExactNumbers(body, fields))).toEqual({ views: "9007199254740993" })
  })

  it("does not touch an embedded resource", () => {
    // An embedded table can have a same-named column of a different kind, and the select that
    // produced it is not parsed here. Rewriting it would be a guess, so row level only.
    const body = '[{"views":9007199254740993,"author":{"views":42}}]'
    const out = quoteExactNumbers(body, fields)
    expect(out).toContain('"views":"9007199254740993"')
    expect(out).toContain('"author":{"views":42}')
  })

  it("is a no-op when no exact fields are known", () => {
    const body = '[{"views":9007199254740993}]'
    expect(quoteExactNumbers(body, {})).toBe(body)
  })
})

describe("coerceExactKinds", () => {
  it("turns a bigint column into a native bigint", () => {
    const rows = [{ views: "9007199254740993", price: "19.0000" }]
    // `toEqual` compares with Object.is, so the string "9007199254740993" would not pass.
    expect(coerceExactKinds(rows, fields)).toEqual([{ views: 9007199254740993n, price: "19.0000" }])
  })

  it("leaves numeric columns as exact strings", () => {
    // `@supatype/types` declares Decimal and Money as `string`. There is no native exact decimal.
    const rows = [{ price: "12345678901234567890.1234" }]
    expect(coerceExactKinds(rows, fields)).toEqual([{ price: "12345678901234567890.1234" }])
  })

  it("leaves null alone", () => {
    expect(coerceExactKinds([{ views: null }], fields)).toEqual([{ views: null }])
  })

  it("round-trips the full path, wire bytes to native bigint", () => {
    const wire = '[{"views":9007199254740993,"balance":19.0000}]'
    const rows = JSON.parse(quoteExactNumbers(wire, fields))
    expect(coerceExactKinds(rows, fields)).toEqual([{ views: 9007199254740993n, balance: "19.0000" }])
  })
})

describe("findLossyNumbers", () => {
  it("names a column whose literal will not survive the parse", () => {
    // The safety net for when column metadata could not be loaded. Without it, a failed metadata
    // fetch would quietly restore the corruption this module exists to remove.
    expect(findLossyNumbers('[{"views":9007199254740993}]')).toEqual(["views"])
  })

  it("says nothing about numbers that round-trip exactly", () => {
    expect(findLossyNumbers('[{"hits":42,"rate":1.5,"edge":9007199254740992}]')).toEqual([])
  })

  it("catches a decimal that loses digits", () => {
    expect(findLossyNumbers('[{"price":12345678901234567890.1234}]')).toEqual(["price"])
  })

  it("does not flag trailing zeros, which lose no value", () => {
    // `19.0000` parsing to `19` is a type-fidelity problem, not a wrong number, and throwing on it
    // would break every project with a money column and no metadata.
    expect(findLossyNumbers('[{"balance":19.0000}]')).toEqual([])
  })

  it("reports each affected column once", () => {
    const body = '[{"views":9007199254740993},{"views":9007199254740995}]'
    expect(findLossyNumbers(body)).toEqual(["views"])
  })

  it("ignores digits inside string values", () => {
    expect(findLossyNumbers('[{"title":"id 9007199254740993 here"}]')).toEqual([])
  })
})

describe("stringifyWithBigInts", () => {
  it("serialises a bigint rather than throwing", () => {
    // `JSON.stringify` throws on a bigint, so writing back a row that was just read would fail
    // the moment the generated types started declaring bigint.
    expect(() => JSON.stringify({ views: 1n })).toThrow(TypeError)
    expect(stringifyWithBigInts({ views: 9007199254740993n })).toBe('{"views":"9007199254740993"}')
  })

  it("leaves everything else as JSON.stringify would", () => {
    const body = { a: 1, b: "x", c: null, d: [1, 2], e: { f: true } }
    expect(stringifyWithBigInts(body)).toBe(JSON.stringify(body))
  })

  it("handles a bigint nested in an array", () => {
    expect(stringifyWithBigInts({ rows: [{ views: 1n }] })).toBe('{"rows":[{"views":"1"}]}')
  })
})
