import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SeedCollector, type Manifest } from "../src/seed-ir.js"
import { connectAuthUsersByKey } from "../src/seed-auth-connect.js"
import type { ExtractedSchemaAst } from "../src/type-extractor.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"
import type { SeedDb, SeedIr } from "../src/seed.js"

/**
 * `authUser: RelatedTo<SupatypeAuthUser>` has no model in the schema, so the engine refused
 * `authUser: { connect: { id } }` with "`supatype:user` is not a model in this schema". The auth
 * user is named by its id, so the connect is written as the relation's own key column.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function schema(): ExtractedSchemaAst {
  const dir = mkdtempSync(join(tmpdir(), "supatype-seed-auth-"))
  dirs.push(dir)
  const path = join(dir, "schema.ts")
  writeFileSync(
    path,
    [
      'import type { Model, UUID, RelatedTo, HasMany, SupatypeAuthUser } from "@supatype/types"',
      "export type Post = Model<{ id: UUID; title: string; authUser: RelatedTo<SupatypeAuthUser>; notes: HasMany<Note> }>",
      "export type Note = Model<{ id: UUID; post: RelatedTo<Post>; reviewer: RelatedTo<SupatypeAuthUser> }>",
      "",
    ].join("\n"),
  )
  const ast = extractSchemaAstFromTypes(path, dir)
  if (ast === null) throw new Error("no models")
  return ast
}

const MANIFEST: Manifest = {
  post: {
    model: "Post",
    table: "post",
    numeric: [],
    temporal: [],
    relations: {
      authUser: { kind: "belongsTo", target: "supatype:user" },
      notes: { kind: "hasMany", target: "Note" },
    },
  },
  note: {
    model: "Note",
    table: "note",
    numeric: [],
    temporal: [],
    relations: {
      post: { kind: "belongsTo", target: "Post" },
      reviewer: { kind: "belongsTo", target: "supatype:user" },
    },
  },
}

/** With no generated builder registered, `SeedDb` is indexed by accessor, as in seed-ir.test.ts. */
function collected(write: (db: SeedDb) => void): SeedIr {
  const collector = new SeedCollector("fp", MANIFEST)
  write(collector.db())
  return collector.finish().ir
}

describe("connecting a relation to an auth user", () => {
  it("writes the relation's key column from connect by id", () => {
    const ir = collected((db) => {
      db["post"]?.upsert({ where: { title: "Hello" }, data: { title: "Hello", authUser: { connect: { id: "u-1" } } } })
    })
    expect(connectAuthUsersByKey(ir, schema()).operations[0]).toMatchObject({
      op: "upsert",
      data: { title: "Hello", auth_user_id: "u-1" },
    })
    expect(JSON.stringify(connectAuthUsersByKey(ir, schema()))).not.toContain("authUser")
  })

  it("does the same inside createMany rows and nested creates", () => {
    const ir = collected((db) => {
      db["note"]?.createMany([{ reviewer: { connect: { id: "u-2" } } }])
      db["post"]?.upsert({
        where: { title: "A" },
        data: { title: "A", authUser: { connect: { id: "u-1" } }, notes: { create: [{ reviewer: { connect: { id: "u-3" } } }] } },
      })
    })
    const [many, upsert] = connectAuthUsersByKey(ir, schema()).operations
    expect(many).toMatchObject({ op: "createMany", rows: [{ reviewer_id: "u-2" }] })
    expect(upsert).toMatchObject({ data: { notes: { create: [{ reviewer_id: "u-3" }] } } })
  })

  it("leaves a connect to a model of the schema to the engine", () => {
    const ir = collected((db) => {
      db["note"]?.createMany([{ post: { connect: { id: "p-1" } }, reviewer_id: "u-1" }])
    })
    expect(connectAuthUsersByKey(ir, schema()).operations[0]).toMatchObject({
      rows: [{ post: { connect: { id: "p-1" } } }],
    })
  })

  it("refuses a connect to an auth user by anything but its id", () => {
    const ir = collected((db) => {
      db["note"]?.createMany([{ reviewer: { connect: { email: "a@b.c" } } }])
    })
    expect(() => connectAuthUsersByKey(ir, schema())).toThrow(/Note\.reviewer.*by its id.*reviewer_id/s)
  })
})
