import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ModelAstV2 } from "../src/schema-ast-v2.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(source: string, label: string): ModelAstV2 | undefined {
  const dir = mkdtempSync(join(tmpdir(), `supatype-access-${label}-`))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(schemaPath, source, "utf8")
  return extractSchemaAstFromTypes(schemaPath, dir)?.models.find((m) => m.name === "Post")
}

function access(model: ModelAstV2 | undefined): Record<string, unknown> {
  return model?.annotations.platform.access ?? {}
}

// Without OR-composition the rule set is a closed list of single shapes, and the
// commonest real requirement — "an admin, or the owner" — cannot be written at all.
describe("Any<[…]>", () => {
  it("composes rules into an OR-join", () => {
    const post = extract(
      `
import type { Model, UUID, Any, Role, Owner, LoggedIn } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
}, {
  access: { update: Any<[Role<"admin">, Owner<"author_id">, LoggedIn]> }
}>
`,
      "any",
    )

    expect(access(post)["update"]).toEqual({
      type: "any",
      rules: [
        { type: "role", roles: ["admin"] },
        { type: "owner", field: "author_id" },
        { type: "authenticated" },
      ],
    })
  })

  it("nests", () => {
    const post = extract(
      `
import type { Model, UUID, Any, Role, Owner } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: { read: Any<[Role<"admin">, Any<[Role<"editor">, Owner<"author_id">]>]> }
}>
`,
      "any-nested",
    )

    expect(access(post)["read"]).toEqual({
      type: "any",
      rules: [
        { type: "role", roles: ["admin"] },
        {
          type: "any",
          rules: [
            { type: "role", roles: ["editor"] },
            { type: "owner", field: "author_id" },
          ],
        },
      ],
    })
  })

  // An empty list reads like a grant and compiles to a policy that grants
  // nothing — exactly the silent denial the unknown-rule error exists to prevent.
  it("rejects an empty list", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Any } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Any<[]> } }>
`,
        "any-empty",
      ),
    ).toThrow(/grants nothing/)
  })

  it("rejects a non-tuple argument", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Any, Role } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Any<Role<"admin">> } }>
`,
        "any-nontuple",
      ),
    ).toThrow(/tuple of rules/)
  })
})

describe("All<[…]> and Not<>", () => {
  it("composes an AND-join and a negation", () => {
    const post = extract(
      `
import type { Model, UUID, All, Not, Role, NotNull } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: { read: All<[Role<"editor">, NotNull<"published_at">, Not<Role<"banned">>]> }
}>
`,
      "all",
    )

    expect(access(post)["read"]).toEqual({
      type: "all",
      rules: [
        { type: "role", roles: ["editor"] },
        { type: "nullCheck", operand: { kind: "column", name: "published_at" }, isNull: false },
        { type: "not", rule: { type: "role", roles: ["banned"] } },
      ],
    })
  })

  // An empty AND is *true*: it reads as a restriction while imposing none, which
  // is the opposite failure from `Any<[]>` and just as silent.
  it("rejects an empty list", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, All } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: All<[]> } }>
`,
        "all-empty",
      ),
    ).toThrow(/grants everything/)
  })
})

describe("comparisons", () => {
  it("treats a bare string as a column and Literal<> as a constant", () => {
    const post = extract(
      `
import type { Model, UUID, All, Eq, Gte, Literal, AuthUid, AuthRole, Claim } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: {
    read: All<[
      Eq<"author_id", AuthUid>,
      Eq<"status", Literal<"published">>,
      Eq<AuthRole, Literal<"admin">>,
      Eq<"tier", Claim<"app_metadata.tier">>,
      Gte<"views", Literal<10>>
    ]>
  }
}>
`,
      "compare",
    )

    expect(access(post)["read"]).toEqual({
      type: "all",
      rules: [
        { type: "compare", op: "eq", left: { kind: "column", name: "author_id" }, right: { kind: "authUid" } },
        {
          type: "compare",
          op: "eq",
          left: { kind: "column", name: "status" },
          right: { kind: "literal", value: "published" },
        },
        {
          type: "compare",
          op: "eq",
          left: { kind: "authRole" },
          right: { kind: "literal", value: "admin" },
        },
        {
          type: "compare",
          op: "eq",
          left: { kind: "column", name: "tier" },
          right: { kind: "claim", path: "app_metadata.tier" },
        },
        {
          type: "compare",
          op: "gte",
          left: { kind: "column", name: "views" },
          right: { kind: "literal", value: 10 },
        },
      ],
    })
  })

  it("extracts IsNull separately from equality", () => {
    const post = extract(
      `
import type { Model, UUID, IsNull } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: IsNull<"deleted_at"> } }>
`,
      "isnull",
    )
    expect(access(post)["read"]).toEqual({
      type: "nullCheck",
      operand: { kind: "column", name: "deleted_at" },
      isNull: true,
    })
  })

  // A bare string becomes a SQL identifier, so anything that is not one has to be
  // refused rather than reaching the policy.
  it("rejects a bare string that is not a column name", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Eq, AuthUid } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Eq<"a b'; drop", AuthUid> } }>
`,
        "compare-badcol",
      ),
    ).toThrow(/not a valid column name/)
  })

  it("rejects a malformed claim path", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Eq, Claim } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Eq<"tier", Claim<"app_metadata..tier">> } }>
`,
        "compare-badclaim",
      ),
    ).toThrow(/not a valid claim path/)
  })

  it("rejects an unknown operand", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Eq, Public } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Eq<"a", Public> } }>
`,
        "compare-badoperand",
      ),
    ).toThrow(/not a valid operand/)
  })
})

describe("In<> membership", () => {
  it("compiles a Rows<> source with its narrowing rule", () => {
    const post = extract(
      `
import type { Model, UUID, In, Rows, Eq, AuthUid } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: { read: In<"site_id", Rows<"user_sites", "site_id", Eq<"user_id", AuthUid>>> }
}>
`,
      "in-rows",
    )

    expect(access(post)["read"]).toEqual({
      type: "in",
      column: "site_id",
      source: {
        kind: "rows",
        table: "user_sites",
        column: "site_id",
        where: {
          type: "compare",
          op: "eq",
          left: { kind: "column", name: "user_id" },
          right: { kind: "authUid" },
        },
      },
    })
  })

  it("accepts a claim array and a fixed set", () => {
    const post = extract(
      `
import type { Model, UUID, Any, In, Claim, Values } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: {
    read: Any<[
      In<"site_id", Claim<"app_metadata.sites">>,
      In<"status", Values<["published", "archived"]>>
    ]>
  }
}>
`,
      "in-claim",
    )

    expect(access(post)["read"]).toEqual({
      type: "any",
      rules: [
        {
          type: "in",
          column: "site_id",
          source: { kind: "claim", path: "app_metadata.sites" },
        },
        {
          type: "in",
          column: "status",
          source: { kind: "literal", values: ["published", "archived"] },
        },
      ],
    })
  })

  it("rejects a source it cannot resolve", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, In, Public } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: In<"a", Public> } }>
`,
        "in-badsource",
      ),
    ).toThrow(/not a valid membership source/)
  })

  it("rejects a table name that is not an identifier", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, In, Rows } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: In<"a", Rows<"a b; drop", "c">> } }>
`,
        "in-badtable",
      ),
    ).toThrow(/not a valid table name/)
  })
})

// The plan's headline parameterisation: the type-level equivalent of Payload's
// access-control factory. Before this, any named alias — even unparameterised —
// was reported as an unknown rule and had to be written inline at every use.
describe("parameterised rule aliases", () => {
  it("expands a generic alias at the point of use", () => {
    const post = extract(
      `
import type { Model, UUID, Any, All, Role, In, Rows, Eq, AuthUid } from "@supatype/types"

type MySites = Rows<"user_sites", "site_id", Eq<"user_id", AuthUid>>
type SiteAccess<Field extends string> = Any<[Role<"admin">, All<[Role<"editor">, In<Field, MySites>]>]>

export type Post = Model<{
  id: UUID
}, {
  access: { update: SiteAccess<"site_id"> }
}>
`,
      "alias",
    )

    expect(access(post)["update"]).toEqual({
      type: "any",
      rules: [
        { type: "role", roles: ["admin"] },
        {
          type: "all",
          rules: [
            { type: "role", roles: ["editor"] },
            {
              type: "in",
              column: "site_id",
              source: {
                kind: "rows",
                table: "user_sites",
                column: "site_id",
                where: {
                  type: "compare",
                  op: "eq",
                  left: { kind: "column", name: "user_id" },
                  right: { kind: "authUid" },
                },
              },
            },
          ],
        },
      ],
    })
  })
})

describe("Custom<sql>", () => {
  it("passes the predicate through verbatim", () => {
    const post = extract(
      `
import type { Model, UUID, Custom } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: { read: Custom<"published_at <= now()"> }
}>
`,
      "custom",
    )

    expect(access(post)["read"]).toEqual({
      type: "custom",
      expression: "published_at <= now()",
    })
  })

  it("composes inside Any", () => {
    const post = extract(
      `
import type { Model, UUID, Any, Role, Custom } from "@supatype/types"

export type Post = Model<{
  id: UUID
}, {
  access: { read: Any<[Role<"admin">, Custom<"published_at <= now()">]> }
}>
`,
      "custom-any",
    )

    expect(access(post)["read"]).toEqual({
      type: "any",
      rules: [
        { type: "role", roles: ["admin"] },
        { type: "custom", expression: "published_at <= now()" },
      ],
    })
  })

  // `Custom<string>` resolves to the *type* `string`; without this check the word
  // "string" would reach Postgres as the policy expression.
  it("rejects a non-literal argument", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Custom } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Custom<string> } }>
`,
        "custom-nonliteral",
      ),
    ).toThrow(/string literal of SQL/)
  })

  it("rejects an empty predicate", () => {
    expect(() =>
      extract(
        `
import type { Model, UUID, Custom } from "@supatype/types"
export type Post = Model<{ id: UUID }, { access: { read: Custom<""> } }>
`,
        "custom-empty",
      ),
    ).toThrow(/empty/)
  })
})
