import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ModelRules } from "../src/views/ModelRules.js"
import { validateRecord } from "../src/lib/validate-record.js"
import { explainRefusal } from "../src/lib/database-refusal.js"
import { countOf } from "../src/lib/inflect.js"
import { testField, testModel } from "./support.js"

/**
 * A bound of one is singular. The Rules tab said "at least 1 items" for a product that needs one
 * item; every count message that names a unit agrees with its number.
 */

describe("countOf", () => {
  it("is singular for one and plural otherwise", () => {
    expect(countOf(1, "item")).toBe("1 item")
    expect(countOf(0, "item")).toBe("0 items")
    expect(countOf(3, "character")).toBe("3 characters")
    expect(countOf(1, "character of text", "characters of text")).toBe("1 character of text")
  })
})

describe("the Rules tab's field bounds", () => {
  const rules = (validation: Record<string, number>, widget: "text" | "richtext" | "json" = "text"): string =>
    renderToStaticMarkup(<ModelRules model={testModel({ fields: [testField({ name: "f", widget, validation })] })} />)

  it("says one item, not 1 items", () => {
    const html = rules({ minItems: 1, maxItems: 1 }, "json")
    expect(html).toContain("at most 1 item, at least 1 item</td>")
    expect(html).not.toContain("1 items")
  })

  it("says one character, not 1 characters", () => {
    expect(rules({ minLength: 1 })).toContain("at least 1 character<")
    expect(rules({ maxLength: 1 }, "richtext")).toContain("at most 1 character of text")
    expect(rules({ maxLength: 2 })).toContain("at most 2 characters")
  })
})

describe("a record's length messages", () => {
  it("says one character, not 1 characters", () => {
    const fields = [testField({ name: "code", label: "Code", validation: { maxLength: 1 } })]
    const [violation] = validateRecord(fields, { code: "ab" })
    expect(violation?.message).toBe("must be 1 character or fewer (currently 2)")
  })
})

describe("the database's too-long refusal", () => {
  it("says one character, not 1 characters", () => {
    const fields = [testField({ name: "code", label: "Code" })]
    const out = explainRefusal(
      { code: "22001", message: "value too long for type character varying(1)" },
      fields,
      { code: "ab" },
    )
    expect(out).toMatchObject({ field: "code", message: "must be 1 character or fewer" })
  })
})
