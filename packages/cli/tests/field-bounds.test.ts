import { describe, expect, it } from "vitest"
import { compileBounds } from "../src/field-bounds.js"
import type { FieldKind } from "../src/schema-ast-v2.js"

// The bug this module exists to prevent: a declared bound that reaches neither Postgres nor Studio
// and raises nothing. Every assertion here is therefore either "this exact SQL" or "this throws".
// A kind that silently returns no check is the failure mode, so there is no test that permits one.

describe("compileBounds: length", () => {
  it("counts characters for text-like kinds", () => {
    expect(compileBounds("title", "text", { maxLength: 120 })).toEqual({
      check: 'char_length("{name}") <= 120',
      validation: { maxLength: 120 },
    })
    expect(compileBounds("email", "email", { minLength: 5 }).check).toBe(
      'char_length("{name}") >= 5',
    )
  })

  it("counts octets for a binary column, not characters", () => {
    expect(compileBounds("blob", "bytes", { maxLength: 1024 }).check).toBe(
      'octet_length("{name}") <= 1024',
    )
  })

  it("counts plain-text characters for rich text, through the managed helper", () => {
    expect(compileBounds("body", "richText", { maxLength: 320 }).check).toBe(
      'char_length(_supatype.richtext_text("{name}")) <= 320',
    )
  })

  it("merges both ends into one constraint", () => {
    expect(compileBounds("body", "text", { maxLength: 4000, minLength: 20 })).toEqual({
      check: '(char_length("{name}") <= 4000) AND (char_length("{name}") >= 20)',
      validation: { maxLength: 4000, minLength: 20 },
    })
  })
})

describe("compileBounds: items", () => {
  it("uses cardinality for a real array, never char_length", () => {
    // char_length(text[]) does not exist: the old generator's output failed CREATE TABLE.
    expect(compileBounds("tags", "array", { maxItems: 10 }).check).toBe(
      'cardinality("{name}") <= 10',
    )
  })

  it("guards jsonb_array_length with a type check", () => {
    // Unguarded, an object value raises "cannot get array length of a non-array" at insert.
    expect(compileBounds("sections", "blocks", { minItems: 1 }).check).toBe(
      'jsonb_typeof("{name}") = \'array\' AND jsonb_array_length("{name}") >= 1',
    )
  })

  it("accepts item bounds on JSON only when the declared type argument is an array", () => {
    expect(compileBounds("items", "json", { minItems: 1 }, { jsonIsArray: true }).check).toBe(
      'jsonb_typeof("{name}") = \'array\' AND jsonb_array_length("{name}") >= 1',
    )
    expect(() => compileBounds("meta", "json", { minItems: 1 })).toThrow(
      /MinItems is not supported on a json field.*JSON<T\[\]>/s,
    )
  })
})

describe("compileBounds: range", () => {
  it("compares a numeric column directly, with no cast", () => {
    expect(compileBounds("score", "integer", { min: 1, max: 5 })).toEqual({
      check: '("{name}" >= 1) AND ("{name}" <= 5)',
      validation: { min: 1, max: 5 },
    })
  })

  it("money and decimal are NUMERIC columns, so they need no cast either", () => {
    expect(compileBounds("price", "money", { min: 0 }).check).toBe('"{name}" >= 0')
    expect(compileBounds("rate", "decimal", { max: 100 }).check).toBe('"{name}" <= 100')
  })

  it("casts a temporal bound to the column's own type", () => {
    expect(compileBounds("startsAt", "datetime", { min: "2026-01-01T00:00:00Z" }).check).toBe(
      `"{name}" >= '2026-01-01T00:00:00Z'::timestamptz`,
    )
    expect(compileBounds("day", "date", { max: "2026-12-31" }).check).toBe(
      `"{name}" <= '2026-12-31'::date`,
    )
    expect(compileBounds("window", "interval", { max: "30 days" }).check).toBe(
      `"{name}" <= '30 days'::interval`,
    )
  })

  it("refuses a string bound on a number and a number bound on a date", () => {
    expect(() => compileBounds("score", "integer", { min: "1" })).toThrow(
      /takes numbers, but "1" is a string/,
    )
    expect(() => compileBounds("day", "date", { min: 20260101 })).toThrow(
      /takes ISO-8601 string bounds, but 20260101 is a number/,
    )
  })

  it("refuses a temporal bound that is not a date, before it reaches a migration", () => {
    expect(() => compileBounds("day", "date", { max: "next tuesday" })).toThrow(
      /is not a valid ISO-8601 date/,
    )
  })
})

describe("compileBounds: refusals name the alternative", () => {
  const cases: Array<[string, FieldKind, Parameters<typeof compileBounds>[2], RegExp]> = [
    ["tags", "array", { maxLength: 10 }, /MaxLength is not supported on a array field.*MaxItems/s],
    ["body", "richText", { maxItems: 3 }, /MaxItems is not supported on a richText field/],
    ["score", "integer", { maxLength: 3 }, /MaxLength is not supported on a integer field/],
    ["title", "text", { min: 1 }, /Between is not supported on a text field/],
    ["status", "enum", { maxLength: 5 }, /union already constrains the permitted values/],
    ["cover", "image", { maxLength: 5 }, /fileSizeLimit and allowedMimeTypes/],
    ["embedding", "vector", { max: 1 }, /dimension is already fixed by the type/],
    ["author", "relation", { maxLength: 5 }, /bound the column on the model this relation points at/],
    ["flag", "boolean", { min: 0 }, /a boolean has two values/],
  ]

  for (const [field, kind, bounds, expected] of cases) {
    it(`${kind} refuses and says where to go instead`, () => {
      expect(() => compileBounds(field, kind, bounds)).toThrow(expected)
    })
  }

  it("names the field, so the error is actionable in a large schema", () => {
    expect(() => compileBounds("setupItems", "json", { maxLength: 3 })).toThrow(/Field "setupItems"/)
  })
})

describe("compileBounds: coverage is enforced, not assumed", () => {
  // Completeness moved from a runtime throw to the type system: `BOUNDS_BY_KIND` is
  // `Record<FieldKind, ...>` and `scalar()` takes a `FieldKind`, so an unclassified kind cannot be
  // written down, let alone reach here. Asserting the old throw would mean calling `compileBounds`
  // with a kind that no longer typechecks, which is the point.

  it("returns nothing when nothing was declared", () => {
    expect(compileBounds("x", "text", {})).toEqual({})
  })
})
