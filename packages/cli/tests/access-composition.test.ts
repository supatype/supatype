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
