import { describe, expect, it } from "vitest"
import { MEASURES, validateRecord } from "../src/lib/validate-record.js"
import { serializeRecordForApi } from "../src/lib/recordValues.js"
import type { FieldConfig, ModelConfig } from "../src/config.js"

/**
 * Studio must refuse exactly what Postgres refuses. Not approximately.
 *
 * Two failures are possible and they are not equally bad. Studio accepting what the database rejects
 * is a poor experience: the author saves and gets a constraint error. Studio **rejecting what the
 * database accepts** is worse, because it blocks a legal save with no recourse and no error anyone
 * can act on. Both come from the same cause, a boundary or a null rule that drifted.
 *
 * Every case below states the SQL it mirrors. The database side of the same claims is asserted in
 * the engine's `field_bounds_enforcement_tests`, which applies real DDL and breaches each bound.
 *
 * The **contract** is shared: `FieldValidation` is declared once in `@supatype/types` and imported by
 * the CLI that writes it and by Studio that reads it, and `MEASURES` is tied to it by a compile-time
 * assertion. What is not shared is the **expectations**: the engine is a separate repository, so the
 * two suites are written against the same semantics rather than the same table. That is the honest
 * remaining seam, and it is why the boundary cases here name the SQL they mirror.
 */

const field = (over: Partial<FieldConfig> & Pick<FieldConfig, "name">): FieldConfig => ({
  label: over.name,
  widget: "text",
  required: false,
  localized: false,
  ...over,
})

const accepts = (config: FieldConfig, value: unknown): boolean =>
  validateRecord([config], { [config.name]: value }).length === 0

interface BoundaryCase {
  /** The SQL Postgres enforces for this bound. */
  sql: string
  config: FieldConfig
  /** Largest/smallest value the bound admits. Inclusive, as `<=` and `>=` are. */
  atTheBoundary: unknown
  /** One step past it. */
  pastTheBoundary: unknown
}

const CASES: BoundaryCase[] = [
  {
    sql: 'char_length("f") <= 5',
    config: field({ name: "f", validation: { maxLength: 5 } }),
    atTheBoundary: "abcde",
    pastTheBoundary: "abcdef",
  },
  {
    sql: 'char_length("f") >= 5',
    config: field({ name: "f", validation: { minLength: 5 } }),
    atTheBoundary: "abcde",
    pastTheBoundary: "abcd",
  },
  {
    sql: 'char_length(_supatype.richtext_text("f")) <= 5',
    config: field({ name: "f", widget: "richtext", validation: { maxLength: 5 } }),
    atTheBoundary: { root: { children: [{ type: "text", text: "abcde" }] } },
    pastTheBoundary: { root: { children: [{ type: "text", text: "abcdef" }] } },
  },
  {
    sql: 'cardinality("f") <= 3',
    config: field({ name: "f", validation: { maxItems: 3 } }),
    atTheBoundary: ["a", "b", "c"],
    pastTheBoundary: ["a", "b", "c", "d"],
  },
  {
    sql: 'jsonb_array_length("f") >= 1',
    config: field({ name: "f", validation: { minItems: 1 } }),
    atTheBoundary: ["a"],
    pastTheBoundary: [],
  },
  {
    sql: '"f" <= 5',
    config: field({ name: "f", widget: "number", validation: { max: 5 } }),
    atTheBoundary: 5,
    pastTheBoundary: 6,
  },
  {
    sql: '"f" >= 1',
    config: field({ name: "f", widget: "number", validation: { min: 1 } }),
    atTheBoundary: 1,
    pastTheBoundary: 0,
  },
  {
    sql: `"f" <= '2026-12-31'::date`,
    config: field({ name: "f", widget: "date", validation: { max: "2026-12-31" } }),
    atTheBoundary: "2026-12-31",
    pastTheBoundary: "2027-01-01",
  },
  {
    sql: `"f" >= '2026-01-01'::date`,
    config: field({ name: "f", widget: "date", validation: { min: "2026-01-01" } }),
    atTheBoundary: "2026-01-01",
    pastTheBoundary: "2025-12-31",
  },
]

describe("bounds parity: Studio and Postgres agree at the boundary", () => {
  for (const { sql, config, atTheBoundary, pastTheBoundary } of CASES) {
    it(`${sql} is inclusive`, () => {
      expect(
        accepts(config, atTheBoundary),
        `Postgres accepts this value under ${sql}, so Studio blocking it would deny a legal save`,
      ).toBe(true)
    })

    it(`${sql} rejects one step past`, () => {
      expect(
        accepts(config, pastTheBoundary),
        `Postgres rejects this value under ${sql}, so Studio accepting it means the save fails later`,
      ).toBe(false)
    })
  }
})

describe("bounds parity: absence", () => {
  // `char_length(NULL) >= 5` is NULL, and a CHECK that evaluates to NULL passes. An absent optional
  // value is therefore legal however tight the bound.
  it("treats null as absent, as a CHECK against NULL does", () => {
    expect(accepts(field({ name: "f", validation: { minLength: 5 } }), null)).toBe(true)
    expect(accepts(field({ name: "f", validation: { minItems: 1 } }), null)).toBe(true)
    expect(accepts(field({ name: "f", widget: "number", validation: { min: 1 } }), null)).toBe(true)
  })

  /**
   * The one place the two could genuinely diverge, asserted as a single property.
   *
   * `char_length('') >= 5` is **false**: Postgres does not treat an empty string as absent. Studio
   * does. Those two facts are only compatible because the record serializer converts `""` to `null`
   * before the write. Tested apart, each half looks correct; the guarantee lives in the pair, so it
   * is asserted as a pair.
   */
  it("only treats a blank string as absent because it is sent as null", () => {
    const config = field({ name: "summary", validation: { minLength: 5 } })
    expect(accepts(config, ""), "Studio treats blank as absent").toBe(true)

    const model = { fields: [config] } as ModelConfig
    expect(
      serializeRecordForApi(model, { summary: "" })["summary"],
      "and it must reach Postgres as NULL, or the database will reject what Studio allowed",
    ).toBeNull()
  })

  // An empty collection is not absent: `jsonb_array_length('[]') >= 1` is false, and the serializer
  // leaves `[]` alone. Both sides reject, which is the agreement being asserted.
  it("does not treat an empty collection as absent", () => {
    const config = field({ name: "tags", validation: { minItems: 1 } })
    expect(accepts(config, [])).toBe(false)
    expect(serializeRecordForApi({ fields: [config] } as ModelConfig, { tags: [] })["tags"]).toEqual(
      [],
    )
  })
})

describe("bounds parity: no measure can be listed and left unenforced", () => {
  // `MEASURES` is tied to `FieldValidation` by a compile-time assertion, so a measure added to the
  // shared contract cannot be missing from the list. This is the other half: it cannot be listed and
  // then ignored either. A breaching value must actually be refused, per measure.
  const BREACH: Record<(typeof MEASURES)[number], { config: Partial<FieldConfig>; value: unknown }> = {
    maxLength: { config: { validation: { maxLength: 2 } }, value: "abc" },
    minLength: { config: { validation: { minLength: 3 } }, value: "ab" },
    maxItems: { config: { validation: { maxItems: 1 } }, value: ["a", "b"] },
    minItems: { config: { validation: { minItems: 2 } }, value: ["a"] },
    min: { config: { widget: "number", validation: { min: 5 } }, value: 4 },
    max: { config: { widget: "number", validation: { max: 5 } }, value: 6 },
  }

  for (const measure of MEASURES) {
    it(`${measure} is enforced, not merely declared`, () => {
      const { config, value } = BREACH[measure]
      expect(
        accepts(field({ name: "f", ...config }), value),
        `${measure} appears in MEASURES but validateRecord accepted a value that breaches it`,
      ).toBe(false)
    })
  }
})
