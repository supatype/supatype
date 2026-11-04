import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { astModels, objectAt } from "../src/ast-read.js"
import { hookTableColumns } from "../src/hook-columns.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function astFor(schema: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "supatype-hookcols-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(schemaPath, schema, "utf8")
  return extractSchemaAstFromTypes(schemaPath, dir)
}

const SCHEMA = `
import type { Int, LoggedIn, Model, PrimaryKey, Public, RelatedTo, Role, UUID } from "@supatype/types"

export type Team = Model<{ id: UUID; name: string }, { tableName: "teams" }>

export type Post = Model<{
  id: UUID
  title: string
  secretNote: string
  salary: number
  team: RelatedTo<Team>
}, {
  tableName: "posts"
  access: {
    read: Public
    create: LoggedIn
    fields: {
      secretNote: { read: Role<"admin"> }
      salary: { write: Role<"admin"> }
      team: { read: Role<"admin"> }
    }
  }
  hooks: {
    beforeChange: { function: "moderate"; columns: "all" }
    afterChange: { function: "notify"; columns: "all" }
    afterDelete: { function: "purge"; columns: "safe" }
  }
}>

export type Membership = Model<{
  org_id: PrimaryKey<Int>
  user_id: PrimaryKey<Int>
  note: string
}, {
  tableName: "memberships"
  hooks: { afterDelete: "purge" }
}>
`

describe("after-hook columns", () => {
  it("carries columns: all on an after-hook and nowhere else", () => {
    const post = astModels(astFor(SCHEMA)).find((model) => model["name"] === "Post")
    expect(objectAt(post, "annotations", "platform", "hooks")).toEqual({
      // A before-hook sees the request, so a `columns` there means nothing and is not carried.
      beforeChange: { function: "moderate" },
      afterChange: { function: "notify", columns: "all" },
      // "safe" is the default, so it is not written.
      afterDelete: { function: "purge" },
    })
  })

  it("lists each hooked table's restricted columns, key and per-hook choice", () => {
    expect(hookTableColumns(astFor(SCHEMA))).toEqual({
      posts: {
        // Only read rules restrict what a hook sees; a write rule hides nothing. A relation's rule
        // names its foreign key column, which is what the row carries.
        restrictedColumns: ["secretNote", "team_id"],
        primaryKey: ["id"],
        columns: { afterChange: "all", afterDelete: "safe" },
      },
      memberships: {
        restrictedColumns: [],
        primaryKey: ["org_id", "user_id"],
        columns: { afterChange: "safe", afterDelete: "safe" },
      },
    })
  })

  it("is empty when no model declares a hook", () => {
    expect(
      hookTableColumns(
        astFor(`
import type { Model, UUID } from "@supatype/types"
export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`),
      ),
    ).toEqual({})
  })
})
