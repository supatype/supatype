import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

// Model-level constraints reuse the access-rule vocabulary deliberately: a constraint is an access
// rule with a narrower operand set. That reuse is the point, and it is also the risk, because the
// wider set is one import away. Everything a CHECK cannot evaluate has to be refused at push time,
// where the message can name the node, rather than at CREATE TABLE where Postgres names nothing.

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(body: string, prelude = ""): ReturnType<typeof extractSchemaAstFromTypes> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-constraints-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `
import type {
  All, Any, AuthUid, Block, Blocks, Bytea, DateTime, Eq, Gte, IsNull, ItemCount, JSON, Length,
  Literal, Lte, Matches, Model, NotNull, Now, Optional, Public, RichText, Role, UUID,
} from "@supatype/types"

${prelude}

${body}
`,
    "utf8",
  )
  return extractSchemaAstFromTypes(schemaPath, dir)
}

const constraintsOf = (ast: ReturnType<typeof extractSchemaAstFromTypes>): unknown[] =>
  (ast?.models[0]?.annotations.db.constraints ?? []) as unknown[]

describe("model constraints", () => {
  it("extracts a cross-column comparison, which no field modifier can express", () => {
    const ast = extract(`
export type Event = Model<{
  id: UUID
  starts_at: DateTime
  ends_at: DateTime
}, {
  access: { read: Public }
  constraints: [Lte<"starts_at", "ends_at">]
}>`)

    expect(constraintsOf(ast)).toEqual([
      {
        type: "compare",
        op: "lte",
        left: { kind: "column", name: "starts_at" },
        right: { kind: "column", name: "ends_at" },
      },
    ])
  })

  it("extracts the item-count and length operands", () => {
    const ast = extract(`
export type Product = Model<{
  id: UUID
  setup_items: JSON<{ label: string }[]>
  sku: string
}, {
  access: { read: Public }
  constraints: [Gte<ItemCount<"setup_items">, Literal<1>>, Lte<Length<"sku">, Literal<32>>]
}>`)

    expect(constraintsOf(ast)).toMatchObject([
      { type: "compare", op: "gte", left: { kind: "itemCount", column: "setup_items" } },
      { type: "compare", op: "lte", left: { kind: "length", column: "sku" } },
    ])
  })

  it("extracts a pattern as a pattern, never as an expression", () => {
    const ast = extract(`
export type Part = Model<{
  id: UUID
  sku: string
}, {
  access: { read: Public }
  constraints: [Matches<"sku", "^[A-Z]{3}$">]
}>`)

    expect(constraintsOf(ast)).toEqual([
      { type: "matches", column: "sku", pattern: "^[A-Z]{3}$" },
    ])
  })

  it("extracts combinators, so a constraint can be more than one comparison", () => {
    const ast = extract(`
export type Page = Model<{
  id: UUID
  status: "draft" | "published"
  published_at: Optional<DateTime>
}, {
  access: { read: Public }
  constraints: [Any<[Eq<"status", Literal<"draft">>, NotNull<"published_at">]>]
}>`)

    const [rule] = constraintsOf(ast) as Array<{ type: string; rules: unknown[] }>
    expect(rule?.type).toBe("any")
    expect(rule?.rules).toHaveLength(2)
  })
})

describe("model constraints: what a CHECK cannot evaluate is refused", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["the caller", "Eq<\"owner_id\", AuthUid>", /cannot see who is writing/],
    ["the caller's role", "Role<\"admin\">", /cannot see the caller's role/],
    ["the clock", "Lte<\"starts_at\", Now>", /cannot read the clock/],
  ]

  for (const [what, rule, expected] of cases) {
    it(`refuses ${what}, naming why`, () => {
      expect(() =>
        extract(`
export type Thing = Model<{
  id: UUID
  owner_id: UUID
  status: string
  starts_at: DateTime
}, {
  access: { read: Public }
  constraints: [${rule}]
}>`),
      ).toThrow(expected)
    })
  }

  it("refuses one nested inside a combinator, not only at the top level", () => {
    expect(() =>
      extract(`
export type Thing = Model<{
  id: UUID
  owner_id: UUID
  status: string
}, {
  access: { read: Public }
  constraints: [All<[Eq<"status", Literal<"live">>, Eq<"owner_id", AuthUid>]>]
}>`),
    ).toThrow(/cannot see who is writing/)
  })

  it("names the model and which constraint, so a large schema stays navigable", () => {
    expect(() =>
      extract(`
export type Thing = Model<{
  id: UUID
  a: DateTime
  b: DateTime
  owner_id: UUID
}, {
  access: { read: Public }
  constraints: [Lte<"a", "b">, Eq<"owner_id", AuthUid>]
}>`),
    ).toThrow(/Model "Thing": constraint 2/)
  })

  it("refuses a constraints value that is not a tuple", () => {
    expect(() =>
      extract(`
export type Thing = Model<{ id: UUID }, {
  access: { read: Public }
  constraints: string
}>`),
    ).toThrow(/`constraints` must be a tuple/)
  })
})

describe("model constraints: absence", () => {
  it("emits no key when a model declares none", () => {
    const ast = extract(`
export type Plain = Model<{ id: UUID }, { access: { read: Public } }>`)
    expect(ast?.models[0]?.annotations.db.constraints).toBeUndefined()
  })
})

describe("the constraint operands stay out of access rules", () => {
  // They share a parser, so nothing syntactic stops one appearing in an `access` block. The engine's
  // RLS renderer has no case for them, so it would emit a policy that does not say what was written.
  it("refuses Length in an access rule, naming where it belongs", () => {
    expect(() =>
      extract(`
export type Doc = Model<{ id: UUID; title: string }, {
  access: { read: Gte<Length<"title">, Literal<5>> }
}>`),
    ).toThrow(/`Length<>` is not supported in an `access` rule.*belongs in `constraints`/s)
  })

  it("refuses Matches in an access rule too", () => {
    expect(() =>
      extract(`
export type Doc = Model<{ id: UUID; sku: string }, {
  access: { read: Matches<"sku", "^[A-Z]{3}$"> }
}>`),
    ).toThrow(/not supported in an `access` rule/)
  })
})

describe("constraint measures resolve to the same form the modifiers use", () => {
  it("resolves Length per storage, not per hope", () => {
    const ast = extract(`
export type Doc = Model<{
  id: UUID
  title: string
  body: RichText
  blob: Bytea
}, {
  access: { read: Public }
  constraints: [
    Lte<Length<"title">, Literal<10>>,
    Lte<Length<"body">, Literal<10>>,
    Lte<Length<"blob">, Literal<10>>,
  ]
}>`)

    expect(constraintsOf(ast)).toMatchObject([
      { left: { kind: "length", column: "title", form: "chars" } },
      { left: { kind: "length", column: "body", form: "richText" } },
      { left: { kind: "length", column: "blob", form: "octets" } },
    ])
  })

  it("tells a real array from a JSON array, which JSONB alone cannot", () => {
    const ast = extract(`
export type Doc = Model<{
  id: UUID
  tags: string[]
  refs: JSON<{ id: string }[]>
  sections: Blocks<Note>
}, {
  access: { read: Public }
  constraints: [
    Lte<ItemCount<"tags">, Literal<3>>,
    Gte<ItemCount<"refs">, Literal<1>>,
    Gte<ItemCount<"sections">, Literal<1>>,
  ]
}>`, "type Note = Block<\"note\", { text: string }>")

    expect(constraintsOf(ast)).toMatchObject([
      { left: { kind: "itemCount", column: "tags", form: "array" } },
      { left: { kind: "itemCount", column: "refs", form: "jsonbArray" } },
      { left: { kind: "itemCount", column: "sections", form: "jsonbArray" } },
    ])
  })

  it("refuses a measure the column cannot take, naming the alternative", () => {
    expect(() =>
      extract(`
export type Doc = Model<{ id: UUID; tags: string[] }, {
  access: { read: Public }
  constraints: [Lte<Length<"tags">, Literal<3>>]
}>`),
    ).toThrow(/an array has items, not characters; use MaxItems\/MinItems/)

    expect(() =>
      extract(`
export type Doc = Model<{ id: UUID; title: string }, {
  access: { read: Public }
  constraints: [Lte<ItemCount<"title">, Literal<3>>]
}>`),
    ).toThrow(/text has characters, not items/)
  })

  it("refuses a measure over a column that is not a field", () => {
    // Composite columns like `created_at` exist in the table and not in `fields`, so the measure
    // cannot be resolved. Saying so beats emitting SQL against a kind nobody classified.
    expect(() =>
      extract(`
export type Doc = Model<{ id: UUID }, {
  access: { read: Public }
  constraints: [Lte<Length<"created_at">, Literal<3>>]
}>`),
    ).toThrow(/is not a field on this model/)
  })

  it("resolves a measure nested inside a combinator", () => {
    const ast = extract(`
export type Doc = Model<{ id: UUID; title: string }, {
  access: { read: Public }
  constraints: [Any<[Lte<Length<"title">, Literal<5>>, IsNull<"title">]>]
}>`)
    const [rule] = constraintsOf(ast) as Array<{ rules: Array<{ left?: { form?: string } }> }>
    expect(rule?.rules[0]?.left?.form).toBe("chars")
  })
})
