import { describe, expect, it } from "vitest"
import { describeViolations, validateRecord } from "../src/lib/validate-record.js"
import type { FieldConfig } from "../src/config.js"

// Every rule here is one Postgres also holds as a CHECK, so the check can only change the message an
// editor sees, never the outcome of a write. A rule with no database counterpart would let Studio
// refuse something the API accepts, which is the failure this module must not have.

const field = (over: Partial<FieldConfig> & Pick<FieldConfig, "name">): FieldConfig => ({
  label: over.name,
  widget: "text",
  required: false,
  localized: false,
  ...over,
})

describe("validateRecord", () => {
  it("reports a value over its declared maxLength", () => {
    const fields = [field({ name: "headline", validation: { maxLength: 10 } })]

    expect(validateRecord(fields, { headline: "x".repeat(11) })).toEqual([
      {
        field: "headline",
        label: "headline",
        message: "must be 10 characters or fewer (currently 11)",
      },
    ])
    expect(validateRecord(fields, { headline: "x".repeat(10) })).toEqual([])
  })

  it("treats a blank optional field as absent rather than too short", () => {
    const fields = [field({ name: "body", validation: { minLength: 20 } })]

    // "" reaches the API as NULL and a CHECK against NULL passes, so refusing it here would block a
    // save the database would have accepted.
    expect(validateRecord(fields, { body: "" })).toEqual([])
    expect(validateRecord(fields, { body: null })).toEqual([])
    expect(validateRecord(fields, { body: "too short" })).toHaveLength(1)
  })

  it("reports numbers outside a declared range", () => {
    const fields = [
      field({ name: "rating", widget: "number", validation: { min: 1, max: 5 } }),
    ]

    expect(validateRecord(fields, { rating: 0 })[0]?.message).toBe("must be 1 or more")
    expect(validateRecord(fields, { rating: 6 })[0]?.message).toBe("must be 5 or less")
    expect(validateRecord(fields, { rating: 3 })).toEqual([])
  })

  it("checks every locale of a translated field", () => {
    const fields = [
      field({ name: "title", localized: true, validation: { maxLength: 5 } }),
    ]

    expect(validateRecord(fields, { title: { en: "short", fr: "beaucoup trop long" } })).toEqual([
      {
        field: "title",
        label: "title",
        locale: "fr",
        message: "must be 5 characters or fewer (currently 18)",
      },
    ])
    expect(validateRecord(fields, { title: { en: "short", fr: "court" } })).toEqual([])
  })

  it("ignores read-only fields and fields with no declared bounds", () => {
    const fields = [
      field({ name: "excerpt", readOnly: true, validation: { maxLength: 3 } }),
      field({ name: "note" }),
    ]

    expect(validateRecord(fields, { excerpt: "far too long", note: "x".repeat(999) })).toEqual([])
  })

  it("joins violations into one banner line", () => {
    const fields = [
      field({ name: "headline", label: "Headline", validation: { maxLength: 2 } }),
      field({ name: "rating", label: "Rating", widget: "number", validation: { max: 5 } }),
    ]

    expect(describeViolations(validateRecord(fields, { headline: "abc", rating: 9 }))).toBe(
      "Headline must be 2 characters or fewer (currently 3); Rating must be 5 or less",
    )
  })
})

describe("validateRecord: collections and rich text", () => {
  it("counts elements for an items bound, not characters", () => {
    const fields = [field({ name: "tags", validation: { maxItems: 3 } })]

    expect(validateRecord(fields, { tags: ["a", "b", "c", "d"] })[0]?.message).toBe(
      "must have 3 items or fewer (currently 4)",
    )
    expect(validateRecord(fields, { tags: ["a", "b", "c"] })).toEqual([])
  })

  it("treats an empty collection as breaching a minimum, unlike an empty string", () => {
    // Postgres agrees: jsonb_array_length('[]') >= 1 is false, while char_length(NULL) >= 1 is NULL.
    const fields = [field({ name: "sections", validation: { minItems: 1 } })]

    expect(validateRecord(fields, { sections: [] })).toHaveLength(1)
    expect(validateRecord(fields, { sections: [{ type: "hero" }] })).toEqual([])
  })

  it("measures rich text by its plain text, as the database helper does", () => {
    const fields = [field({ name: "body", widget: "richtext", validation: { maxLength: 5 } })]
    const doc = (text: string) => ({ root: { children: [{ type: "text", text }] } })

    expect(validateRecord(fields, { body: doc("hello") })).toEqual([])
    expect(validateRecord(fields, { body: doc("hello there") })[0]?.message).toBe(
      "must be 5 characters or fewer (currently 11)",
    )
  })

  it("never lets a length bound stand in for an item count", () => {
    // The database has no char_length for an array, so a maxLength that somehow reaches one is a
    // stale config, not an item limit. Silently reinterpreting it would rebuild the conflation that
    // splitting MaxLength from MaxItems removed.
    const fields = [field({ name: "tags", validation: { maxLength: 1 } })]

    expect(validateRecord(fields, { tags: ["a", "b", "c"] })).toEqual([])
  })

  it("compares temporal bounds as dates, not as strings", () => {
    const fields = [
      field({ name: "day", widget: "date", validation: { min: "2026-01-01", max: "2026-12-31" } }),
    ]

    expect(validateRecord(fields, { day: "2026-06-01" })).toEqual([])
    expect(validateRecord(fields, { day: "2027-06-01" })[0]?.message).toBe(
      "must be 2026-12-31 or less",
    )
    expect(validateRecord(fields, { day: "2025-06-01" })[0]?.message).toBe(
      "must be 2026-01-01 or more",
    )
  })
})

describe("describeViolations", () => {
  it("names the locale that breached, so a five-locale model is actionable", () => {
    const fields = [
      field({ name: "title", label: "Title", localized: true, validation: { maxLength: 5 } }),
    ]

    const message = describeViolations(
      validateRecord(fields, { title: { en: "short", de: "viel zu lang" } }),
    )
    expect(message).toBe("Title (de) must be 5 characters or fewer (currently 12)")
  })

  it("leaves an untranslated field unqualified", () => {
    const fields = [field({ name: "slug", label: "Slug", validation: { maxLength: 3 } })]

    expect(describeViolations(validateRecord(fields, { slug: "abcd" }))).toBe(
      "Slug must be 3 characters or fewer (currently 4)",
    )
  })
})
