import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generateInsertType, generateRowType, generateUpdateType } from "../src/augmentation-generator.js"
import type { FieldAstV2 } from "../src/schema-ast-v2.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

// Identity and generated columns (identity-contract): the options form and the aliases compile to
// one AST encoding, which is all the engine reads.

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fieldsOf(body: string, imports = "Model, Int, SmallInt, BigInt, Float, TSVector, Identity, Generated, AutoIncrement, PrimaryKey, Optional, Email"): Record<string, FieldAstV2> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-identity-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `import type { ${imports} } from "@supatype/types"\n\nexport type Post = Model<{\n${body}\n}>\n`,
    "utf8",
  )
  const ast = extractSchemaAstFromTypes(schemaPath, dir)
  const post = ast?.models.find((m) => m.name === "Post")
  if (post === undefined) throw new Error("no model")
  return post.fields
}

const identityAlways = {
  kind: "integer",
  required: true,
  identity: "always",
  annotations: { db: { pgType: "INTEGER", serverGenerated: true } },
}

describe("identity columns", () => {
  it("compiles the options form and every alias to the same field", () => {
    const fields = fieldsOf(`
  a: Int<{ identity: "always" }>
  b: Identity<number>
  c: Identity
  e: Identity<Int>
`)
    for (const key of ["a", "b", "c", "e"]) {
      expect(fields[key], key).toMatchObject(identityAlways)
      expect(fields[key], key).not.toHaveProperty("autoIncrement")
    }
  })

  it("compiles AutoIncrement to an identity by default that says it is one", () => {
    const fields = fieldsOf(`
  a: AutoIncrement<number>
  b: AutoIncrement
  c: AutoIncrement<bigint>
  d: Identity<number, "by-default">
`)
    const auto = { identity: "byDefault", autoIncrement: true, required: true }
    // Not the old SERIAL: an identity by default, which a serial made then satisfies.
    expect(fields["a"]).toMatchObject({ kind: "integer", ...auto, annotations: { db: { serverGenerated: true } } })
    expect(fields["b"]).toMatchObject({ kind: "integer", ...auto })
    expect(fields["c"]).toMatchObject({ kind: "bigInt", ...auto })
    // The explicit form is not AutoIncrement: on a serial column it converts it.
    expect(fields["d"]).toMatchObject({ kind: "integer", identity: "byDefault" })
    expect(fields["d"]).not.toHaveProperty("autoIncrement")
  })

  it("spells by-default as the AST does, and keeps the integer's width", () => {
    const fields = fieldsOf(`
  a: BigInt<{ identity: "by-default" }>
  b: Identity<bigint, "by-default">
  c: SmallInt<{ identity: "by-default" }>
  d: Identity<SmallInt, "by-default">
`)
    expect(fields["a"]).toMatchObject({ kind: "bigInt", identity: "byDefault" })
    expect(fields["b"]).toMatchObject({ kind: "bigInt", identity: "byDefault" })
    expect(fields["c"]).toMatchObject({ kind: "smallInt", identity: "byDefault" })
    expect(fields["d"]).toMatchObject({ kind: "smallInt", identity: "byDefault" })
  })

  it("is always required, and a primary key may be one", () => {
    const fields = fieldsOf(`  id: PrimaryKey<Identity<number>>`)
    expect(fields["id"]).toMatchObject({ ...identityAlways, primaryKey: true })
  })

  it("refuses what is not an integer or not a mode", () => {
    expect(() => fieldsOf(`  a: Float<{ identity: "always" }>`)).toThrow(/only an integer field/)
    expect(() => fieldsOf(`  a: Int<{ identity: "sometimes" }>`)).toThrow(/"always" or "by-default"/)
    expect(() => fieldsOf(`  a: Identity<number, "sometimes">`)).toThrow(/"always" or "by-default"/)
    expect(() => fieldsOf(`  a: Int<{ idenity: "always" }>`)).toThrow(/takes identity and generated, not idenity/)
  })
})

describe("generated columns", () => {
  it("compiles the options form and the alias to the same field", () => {
    const fields = fieldsOf(`
  title: string
  a: Generated<string, "lower(title)">
  b: Optional<Generated<string, "lower(title)">>
  c: Float<{ generated: "price * qty" }>
  d: Generated<Float, "price * qty">
  e: TSVector<{ generated: "to_tsvector('english', title)" }>
  f: Email<{ generated: "lower(title) || '@example.com'" }>
`)
    expect(fields["a"]).toMatchObject({
      kind: "text",
      required: true,
      generated: { expression: "lower(title)", stored: true },
      annotations: { db: { serverGenerated: true } },
    })
    expect(fields["b"]).toMatchObject({ kind: "text", required: false, generated: { expression: "lower(title)" } })
    expect(fields["c"]).toEqual(fields["d"])
    expect(fields["c"]).toMatchObject({ kind: "float", generated: { expression: "price * qty", stored: true } })
    expect(fields["e"]).toMatchObject({ kind: "tsVector", generated: { expression: "to_tsvector('english', title)" } })
    expect(fields["f"]).toMatchObject({ kind: "email" })
    expect(fields["title"]).not.toHaveProperty("generated")
  })

  it("refuses an expression that is not a string literal, and both at once", () => {
    expect(() => fieldsOf(`  a: Generated<string, 1>`)).toThrow(/string literal/)
    expect(() => fieldsOf(`  a: Float<{ generated: "" }>`)).toThrow(/string literal/)
    expect(() => fieldsOf(`  a: Generated<Int<{ identity: "always" }>, "1">`)).toThrow(/not both/)
  })

  it("is not localized in a localized model", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-generated-localized-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `import type { LocalizedModel, Generated, LocaleConfig } from "@supatype/types"
export type Locales = LocaleConfig<["en", "de"], "en">
export type Page = LocalizedModel<{ title: string; key: Generated<string, "md5(id::text)"> }>
`,
      "utf8",
    )
    const page = extractSchemaAstFromTypes(schemaPath, dir)?.models.find((m) => m.name === "Page")
    expect(page?.fields["title"]).toMatchObject({ localized: true })
    expect(page?.fields["key"]).not.toHaveProperty("localized")
  })
})

describe("client augmentation", () => {
  const fields: Record<string, Record<string, unknown>> = {
    id: { ...identityAlways },
    seq: { kind: "bigInt", required: true, identity: "byDefault", annotations: { db: { serverGenerated: true } } },
    title: { kind: "text", required: true },
    title_lower: { kind: "text", required: false, generated: { expression: "lower(title)", stored: true } },
  }

  it("reads every column on the row", () => {
    const row = generateRowType(fields)
    expect(row).toContain("id: number")
    expect(row).toContain("title_lower: string | null")
  })

  it("never writes a generated or always-identity column, and numbers a by-default one when left out", () => {
    const insert = generateInsertType(fields)
    expect(insert).toContain("id?: never")
    expect(insert).toContain("title_lower?: never")
    expect(insert).toContain("seq?: bigint")
    expect(insert).toMatch(/\btitle: string/)
    const update = generateUpdateType(fields)
    expect(update).toContain("id?: never")
    expect(update).toContain("title_lower?: never")
    expect(update).toContain("seq?: bigint")
  })
})
