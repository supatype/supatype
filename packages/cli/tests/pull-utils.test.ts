import { describe, it, expect } from "vitest"
import { pgTypeToField, toCamelCase, type ColumnInfo } from "../src/pull-utils.js"

function col(overrides: Partial<ColumnInfo> & { pgType: string }): ColumnInfo {
  return {
    name: "col",
    nullable: true,
    isPrimary: false,
    isUnique: false,
    hasDefault: false,
    ...overrides,
  }
}

describe("pgTypeToField()", () => {
  it.each([
    ["uuid", "field.uuid("],
    ["text", "field.text("],
    ["varchar(255)", "field.text("],
    ["character varying", "field.text("],
    ["int4", "field.integer("],
    ["integer", "field.integer("],
    ["int8", "field.bigInt("],
    ["bigint", "field.bigInt("],
    ["int2", "field.smallInt("],
    ["smallint", "field.smallInt("],
    ["float8", "field.float("],
    ["double precision", "field.float("],
    ["real", "field.float("],
    ["numeric", "field.decimal("],
    ["decimal", "field.decimal("],
    ["bool", "field.boolean("],
    ["boolean", "field.boolean("],
    ["date", "field.date("],
    ["timestamp", "field.timestamp("],
    ["timestamptz", "field.datetime("],
    ["timestamp with time zone", "field.datetime("],
    ["json", "field.json("],
    ["jsonb", "field.json("],
    ["inet", "field.ip("],
    ["cidr", "field.cidr("],
    ["macaddr", "field.macaddr("],
    ["bytea", "field.bytea("],
    ["money", "field.money("],
    ["xml", "field.xml("],
    ["interval", "field.interval("],
    ["tsvector", "field.tsvector("],
    ["tsquery", "field.tsquery("],
  ])("maps %s → %s call", (pgType, expectedPrefix) => {
    const result = pgTypeToField(col({ pgType }))
    expect(result).toContain(expectedPrefix)
  })

  it("unknown types fall back to field.text with a TODO comment", () => {
    const result = pgTypeToField(col({ pgType: "some_custom_type" }))
    expect(result).toContain("field.text(")
    expect(result).toContain("TODO")
    expect(result).toContain("some_custom_type")
  })

  it("nullable column sets required: false", () => {
    const result = pgTypeToField(col({ pgType: "text", nullable: true }))
    expect(result).toContain('"required":false')
  })

  it("non-nullable column sets required: true", () => {
    const result = pgTypeToField(col({ pgType: "text", nullable: false }))
    expect(result).toContain('"required":true')
  })

  it("primary key column sets primaryKey: true", () => {
    const result = pgTypeToField(
      col({ pgType: "uuid", isPrimary: true, nullable: false }),
    )
    expect(result).toContain('"primaryKey":true')
  })

  it("unique (non-PK) column sets unique: true", () => {
    const result = pgTypeToField(
      col({ pgType: "text", isUnique: true, isPrimary: false }),
    )
    expect(result).toContain('"unique":true')
  })

  it("primary key column does not also set unique (redundant)", () => {
    const result = pgTypeToField(
      col({ pgType: "uuid", isPrimary: true, isUnique: true }),
    )
    expect(result).not.toContain('"unique"')
  })

  it("jsonb column includes jsonb: true spread", () => {
    const result = pgTypeToField(col({ pgType: "jsonb" }))
    expect(result).toContain("jsonb: true")
  })

  it("plain json column does not include jsonb spread", () => {
    const result = pgTypeToField(col({ pgType: "json" }))
    expect(result).not.toContain("jsonb")
  })
})

describe("toCamelCase()", () => {
  it.each([
    ["user", "User"],
    ["blog_post", "BlogPost"],
    ["order_line_item", "OrderLineItem"],
    ["saas_tenant", "SaasTenant"],
    ["alreadyCamel", "AlreadyCamel"],
    ["a", "A"],
    ["api_key", "ApiKey"],
  ])("converts %s → %s", (input, expected) => {
    expect(toCamelCase(input)).toBe(expected)
  })
})
