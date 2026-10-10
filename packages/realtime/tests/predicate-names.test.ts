import { describe, expect, it } from "vitest"
import { fieldReadPredicateName, makeObjectName, rowReadPredicateName } from "../src/predicate-names.js"

// Every expected name below is what the schema engine created in a tier-2 database for the table
// `quarterly_compensation_review_record_for_employee`, read back from pg_proc.
const TABLE = "quarterly_compensation_review_record_for_employee"
const LONG_COLUMN = "confidentialAnnualBaseSalaryBeforeTaxesAndDeductionsAmount"
const LONG_SIBLING = "confidentialAnnualBaseSalaryBeforeTaxesAndDeductionsCurrency"

describe("generated predicate names", () => {
  it("names short tables and columns plainly", () => {
    expect(rowReadPredicateName("employee")).toBe("can_read_employee")
    expect(fieldReadPredicateName("employee", "salary")).toBe("can_read_employee__salary")
  })

  it("shortens the table part first when the name runs past 63 bytes", () => {
    expect(fieldReadPredicateName(TABLE, "note")).toBe(
      "can_read_quarterly_compensation_review_record_for_employee_note",
    )
    expect(rowReadPredicateName(TABLE)).toBe("can_read_quarterly_compensation_review_record_for_employee")
  })

  it("shortens both parts toward equal length", () => {
    expect(fieldReadPredicateName(TABLE, LONG_COLUMN)).toBe(
      "can_read_quarterly_compensation_confidentialAnnualBaseSalaryBef",
    )
  })

  // The engine numbers the second of two colliding names (`..._1`). Realtime cannot know which
  // column came second, so the shared base name is what it must notice.
  it("gives two long columns sharing a prefix the same base name", () => {
    expect(fieldReadPredicateName(TABLE, LONG_SIBLING)).toBe(fieldReadPredicateName(TABLE, LONG_COLUMN))
  })

  it("never splits a multi-byte character", () => {
    const name = makeObjectName("a".repeat(40), "é".repeat(20), "")
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63)
    expect(name).not.toContain("�")
  })
})
