import { describe, expect, it } from "vitest"
import { qualifiedName, quoteIdent } from "../src/lib/sql-identifier.js"

/**
 * Studio writes schema, table, policy and role names into the SQL it drafts. Postgres folds a bare
 * name to lowercase and reads a quote as the end of one, so every name is quoted exactly as the
 * catalogue spelled it, with nothing folded and nothing swapped for another name.
 */

describe("quoteIdent", () => {
  it.each([
    ["public", '"public"'],
    ["MyApp", '"MyApp"'],
    ['My"App', '"My""App"'],
    ['""', '""""""'],
    ["order items", '"order items"'],
    ["my-app.v2", '"my-app.v2"'],
  ])("quotes %s as %s", (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted)
  })
})

describe("qualifiedName", () => {
  it("quotes the schema and the name each on their own", () => {
    expect(qualifiedName('My"App', "Order Items")).toBe('"My""App"."Order Items"')
  })
})
