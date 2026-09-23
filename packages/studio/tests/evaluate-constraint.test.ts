import { describe, expect, it } from "vitest"
import { validateRecord, describeViolations } from "../src/lib/validate-record.js"
import { evaluate, type ConstraintNode, type ModelConstraint } from "../src/lib/evaluate-constraint.js"
import type { FieldConfig } from "../src/config.js"

/**
 * Model constraints checked in the browser against the nodes the database compiled.
 *
 * The verdicts must match what the `CHECK` decides, and the dangerous direction is Studio saying no
 * where Postgres says yes: that blocks a legal save with no recourse. So the absent-value cases below
 * matter more than the failing ones, and they follow SQL three-valued logic rather than JavaScript's
 * idea of falsy.
 */

const field = (over: Partial<FieldConfig> & Pick<FieldConfig, "name">): FieldConfig => ({
  label: over.name,
  widget: "text",
  required: false,
  localized: false,
  ...over,
})

const col = (name: string): ConstraintNode => ({ kind: "column", name })
const lit = (value: unknown): ConstraintNode => ({ kind: "literal", value })
const compare = (op: string, left: ConstraintNode, right: ConstraintNode): ConstraintNode => ({
  type: "compare",
  op,
  left,
  right,
})

const FIELDS = [
  field({ name: "starts_at", label: "Starts at", widget: "date" }),
  field({ name: "ends_at", label: "Ends at", widget: "date" }),
  field({ name: "sku", label: "SKU" }),
  field({ name: "tags", label: "Tags" }),
  field({ name: "body", label: "Body", widget: "richtext" }),
  field({ name: "status", label: "Status" }),
]

describe("evaluate: comparisons", () => {
  it("orders dates as dates, not as strings", () => {
    const rule = compare("lte", col("starts_at"), col("ends_at"))
    expect(evaluate(rule, FIELDS, { starts_at: "2026-01-01", ends_at: "2026-02-01" })).toBe(true)
    expect(evaluate(rule, FIELDS, { starts_at: "2026-02-01", ends_at: "2026-01-01" })).toBe(false)
    // Inclusive, as `<=` is.
    expect(evaluate(rule, FIELDS, { starts_at: "2026-01-01", ends_at: "2026-01-01" })).toBe(true)
  })

  it("measures length and item count in the same unit the CHECK counts", () => {
    const items = compare("gte", { kind: "itemCount", column: "tags", form: "array" }, lit(2))
    expect(evaluate(items, FIELDS, { tags: ["a", "b"] })).toBe(true)
    expect(evaluate(items, FIELDS, { tags: ["a"] })).toBe(false)

    const length = compare("lte", { kind: "length", column: "body", form: "richText" }, lit(5))
    const doc = (text: string) => ({ root: { children: [{ type: "text", text }] } })
    expect(evaluate(length, FIELDS, { body: doc("hello") })).toBe(true)
    expect(evaluate(length, FIELDS, { body: doc("hello there") })).toBe(false)
  })

  it("matches a pattern", () => {
    const rule: ConstraintNode = { type: "matches", column: "sku", pattern: "^[A-Z]{3}$" }
    expect(evaluate(rule, FIELDS, { sku: "ABC" })).toBe(true)
    expect(evaluate(rule, FIELDS, { sku: "abc" })).toBe(false)
  })
})

describe("evaluate: absence follows SQL, not JavaScript", () => {
  // `NULL <= x` is NULL, and a CHECK evaluating to NULL passes. Anything else here blocks a save the
  // database would accept, which is the failure that has no recourse for the author.
  it("cannot say when an operand is missing, and that passes", () => {
    const rule = compare("lte", col("starts_at"), col("ends_at"))
    expect(evaluate(rule, FIELDS, { starts_at: null, ends_at: "2026-01-01" })).toBeNull()
    expect(evaluate(rule, FIELDS, { ends_at: "2026-01-01" })).toBeNull()
    expect(evaluate(rule, FIELDS, { starts_at: "", ends_at: "2026-01-01" })).toBeNull()
  })

  it("passes a rule it does not understand, because the database still enforces it", () => {
    expect(evaluate({ type: "somethingNewer" }, FIELDS, {})).toBeNull()
    expect(evaluate(compare("lte", { kind: "authUid" }, lit(1)), FIELDS, {})).toBeNull()
  })

  it("treats a null check as the database does", () => {
    const notNull: ConstraintNode = { type: "nullCheck", operand: col("sku"), isNull: false }
    expect(evaluate(notNull, FIELDS, { sku: "ABC" })).toBe(true)
    expect(evaluate(notNull, FIELDS, { sku: null })).toBe(false)
  })
})

describe("evaluate: combinators", () => {
  const draft = compare("eq", col("status"), lit("draft"))
  const published: ConstraintNode = { type: "nullCheck", operand: col("sku"), isNull: false }

  it("any holds when one part holds", () => {
    const rule: ConstraintNode = { type: "any", rules: [draft, published] }
    expect(evaluate(rule, FIELDS, { status: "draft", sku: null })).toBe(true)
    expect(evaluate(rule, FIELDS, { status: "live", sku: "ABC" })).toBe(true)
    expect(evaluate(rule, FIELDS, { status: "live", sku: null })).toBe(false)
  })

  it("all fails when one part fails", () => {
    const rule: ConstraintNode = { type: "all", rules: [draft, published] }
    expect(evaluate(rule, FIELDS, { status: "draft", sku: "ABC" })).toBe(true)
    expect(evaluate(rule, FIELDS, { status: "live", sku: "ABC" })).toBe(false)
  })

  it("an unknown part makes the verdict unknown rather than false", () => {
    const rule: ConstraintNode = { type: "all", rules: [draft, { type: "somethingNewer" }] }
    expect(evaluate(rule, FIELDS, { status: "draft" })).toBeNull()
  })
})

describe("constraints in validateRecord", () => {
  const constraint = (rule: ConstraintNode, columns: string[]): ModelConstraint => ({
    name: "events_check_1",
    columns,
    rule,
  })

  it("attributes a single-column rule to its field", () => {
    const rule: ConstraintNode = { type: "matches", column: "sku", pattern: "^[A-Z]{3}$" }
    const [violation] = validateRecord(FIELDS, { sku: "abc" }, [constraint(rule, ["sku"])])

    expect(violation?.field).toBe("sku")
    expect(violation?.label).toBe("SKU")
    // The label already names the field, so the message does not repeat it.
    expect(violation?.message).toBe("must match ^[A-Z]{3}$")
  })

  it("attributes a cross-column rule to the model, since no one input is at fault", () => {
    const rule = compare("lte", col("starts_at"), col("ends_at"))
    const [violation] = validateRecord(
      FIELDS,
      { starts_at: "2026-02-01", ends_at: "2026-01-01" },
      [constraint(rule, ["starts_at", "ends_at"])],
    )

    expect(violation?.field).toBe("events_check_1")
    expect(violation?.message).toBe("Starts at must be on or before Ends at")
  })

  it("reports the failing part of an all, not the whole rule", () => {
    // "does not satisfy the constraint" is not actionable; naming the part that failed is.
    const rule: ConstraintNode = {
      type: "all",
      rules: [
        compare("lte", col("starts_at"), col("ends_at")),
        { type: "matches", column: "sku", pattern: "^[A-Z]{3}$" },
      ],
    }
    const [violation] = validateRecord(
      FIELDS,
      { starts_at: "2026-01-01", ends_at: "2026-02-01", sku: "abc" },
      [constraint(rule, ["starts_at", "ends_at", "sku"])],
    )
    expect(violation?.message).toBe("SKU must match ^[A-Z]{3}$")
  })

  it("says nothing when the rule holds, or cannot be decided", () => {
    const rule = compare("lte", col("starts_at"), col("ends_at"))
    expect(validateRecord(FIELDS, { starts_at: "2026-01-01", ends_at: "2026-02-01" }, [
      constraint(rule, ["starts_at", "ends_at"]),
    ])).toEqual([])
    expect(validateRecord(FIELDS, { ends_at: "2026-02-01" }, [
      constraint(rule, ["starts_at", "ends_at"]),
    ])).toEqual([])
  })

  it("names the locale when a translated field breaches", () => {
    const localized = [field({ name: "title", label: "Title", localized: true })]
    const rule: ConstraintNode = { type: "matches", column: "title", pattern: "^[A-Z]" }
    const violations = validateRecord(
      localized,
      { title: { en: "Hello", fr: "bonjour" } },
      [{ name: "c1", columns: ["title"], rule }],
    )
    expect(describeViolations(violations)).toBe("Title (fr) must match ^[A-Z]")
  })
})
