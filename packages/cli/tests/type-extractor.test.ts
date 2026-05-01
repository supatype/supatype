import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("extractSchemaAstFromTypes", () => {
  it("extracts exported Model aliases into engine-compatible AST", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Slug, Unique, RichText, Optional, Public, Owner, RelatedTo } from "@supatype/types"

export type Post = Model<{
  id: UUID
  slug: Unique<Slug>
  title: string
  body: RichText
  publishedAt: Optional<Date>
}, {
  access: { read: Public; update: Owner<"author_id">; delete: Owner<"author_id"> }
}>

export type Comment = Model<{
  id: UUID
  post: RelatedTo<Post>
}, {
  access: { read: Public }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast).not.toBeNull()
    expect(ast?.models).toHaveLength(2)
    const post = ast?.models.find((m) => m.name === "Post")
    const comment = ast?.models.find((m) => m.name === "Comment")
    expect(post?.tableName).toBe("post")
    expect(comment?.fields["post"]).toMatchObject({
      kind: "relation",
      cardinality: "belongsTo",
      target: "Post",
      foreignKey: "post_id",
    })
    expect(post?.fields["id"]).toMatchObject({ kind: "uuid", pgType: "UUID" })
    expect(post?.fields["id"]).toMatchObject({
      primaryKey: true,
      unique: true,
      required: true,
      default: { kind: "genRandomUuid" },
    })
    expect(post?.fields["slug"]).toMatchObject({ kind: "slug", unique: true, from: "title" })
    expect(post?.access["read"]).toEqual({ type: "public" })
    expect(post?.access["update"]).toEqual({ type: "owner", field: "author_id" })
    expect(post?.access["delete"]).toEqual({ type: "owner", field: "author_id" })
  })

  it("unwraps Default<> so boolean fields stay boolean in the AST", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Default } from "@supatype/types"

export type Flags = Model<{
  id: UUID
  isActive: Default<boolean, true>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.models[0]?.fields["isActive"]).toMatchObject({ kind: "boolean", pgType: "BOOLEAN" })
  })

  it("extracts Bucket<> config into storageBuckets and field accessMode", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-bucket-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Public, LoggedIn, ImageAsset, Bucket } from "@supatype/types"

export type covers = Bucket<
  "covers",
  {
    accessMode: "public"
    maxSize: "2MB"
    accept: readonly ["image/jpeg", "image/png"]
    access: { read: Public; create: LoggedIn; delete: LoggedIn }
  }
>

export type Post = Model<{
  id: UUID
  hero: ImageAsset<covers>
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.storageBuckets).toBeDefined()
    const b = ast?.storageBuckets?.find((x) => x.id === "covers")
    expect(b?.public).toBe(true)
    expect(b?.accessMode).toBe("public")
    expect(b?.fileSizeLimit).toBe(2 * 1024 * 1024)
    expect(b?.allowedMimeTypes).toEqual(["image/jpeg", "image/png"])
    expect(b?.access?.read).toEqual({ type: "public" })

    const hero = ast?.models[0]?.fields["hero"]
    expect(hero).toMatchObject({ kind: "image", bucket: "covers", accessMode: "public" })
  })

  it("extracts accessMode custom and s3BucketPolicy string", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-bucket-custom-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, ImageAsset, Bucket } from "@supatype/types"

export type assets = Bucket<"legacy", {
  accessMode: "custom"
  s3BucketPolicy: '{"Version":"2012-10-17"}'
}>

export type X = Model<{
  id: UUID
  f: ImageAsset<assets>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const b = ast?.storageBuckets?.find((x) => x.id === "legacy")
    expect(b?.accessMode).toBe("custom")
    expect(b?.public).toBe(false)
    expect(b?.s3BucketPolicy).toBe('{"Version":"2012-10-17"}')
  })

  it("extracts slug source field from Slug<\"name\">", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Slug, Unique } from "@supatype/types"

export type Article = Model<{
  id: UUID
  name: string
  slug: Unique<Slug<"name">>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.models[0]?.fields["slug"]).toMatchObject({ kind: "slug", from: "name" })
  })
})
