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

  it("emits DEFAULT now for created_at / updated_at timestamp columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-audit-ts-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Timestamp } from "@supatype/types"

export type Entry = Model<{ id: UUID; created_at: Timestamp; updated_at: Timestamp }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const entry = ast?.models.find((m) => m.name === "Entry")
    expect(entry?.fields["created_at"]).toMatchObject({
      kind: "datetime",
      serverGenerated: true,
      default: { kind: "now" },
    })
    expect(entry?.fields["updated_at"]).toMatchObject({
      kind: "datetime",
      serverGenerated: true,
      default: { kind: "now" },
    })
  })

  it("extracts Owner<Model, Key> using the key argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-owner-model-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Public, Owner } from "@supatype/types"

export type User = Model<{
  id: UUID
}, {
  access: { read: Public; update: Owner<User, "id">; delete: Owner<User, "id"> }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.access["update"]).toEqual({ type: "owner", field: "id" })
    expect(user?.access["delete"]).toEqual({ type: "owner", field: "id" })
  })

  it("maps SupatypeAuthUser relations and OwnerFrom relation keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-auth-owner-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, RelatedTo, SupatypeAuthUser, OwnerFrom, LoggedIn } from "@supatype/types"

export type Post = Model<{
  id: UUID
  authUser: RelatedTo<SupatypeAuthUser>
}, {
  access: { create: LoggedIn; update: OwnerFrom<"authUser">; delete: OwnerFrom<"authUser"> }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const post = ast?.models.find((m) => m.name === "Post")
    expect(post?.fields["authUser"]).toMatchObject({
      kind: "relation",
      cardinality: "belongsTo",
      target: "supatype:user",
      foreignKey: "auth_user_id",
    })
    expect(post?.access["update"]).toEqual({ type: "owner", field: "auth_user_id" })
    expect(post?.access["delete"]).toEqual({ type: "owner", field: "auth_user_id" })
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

  it("normalizes RelatedTo foreign keys for fields ending in Id/ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, RelatedTo } from "@supatype/types"

export type Author = Model<{ id: UUID }>

export type Comment = Model<{
  id: UUID
  author: RelatedTo<Author>
  userId: RelatedTo<Author>
  customerID: RelatedTo<Author>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const comment = ast?.models.find((m) => m.name === "Comment")
    expect(comment?.fields["author"]).toMatchObject({ foreignKey: "author_id" })
    expect(comment?.fields["userId"]).toMatchObject({ foreignKey: "user_id" })
    expect(comment?.fields["customerID"]).toMatchObject({ foreignKey: "customer_id" })
  })

  it("extracts EditorReadOnly wrapper as readOnly field metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-readonly-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, EditorReadOnly, RelatedTo } from "@supatype/types"

export type User = Model<{ id: UUID }>

export type Doc = Model<{
  id: UUID
  title: EditorReadOnly<string>
  owner: EditorReadOnly<RelatedTo<User>>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const doc = ast?.models.find((m) => m.name === "Doc")
    expect(doc?.fields["title"]).toMatchObject({ kind: "text", readOnly: true })
    expect(doc?.fields["owner"]).toMatchObject({ kind: "relation", readOnly: true })
  })

  it("extracts Computed wrapper as readOnly + serverGenerated metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-computed-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Computed, Optional } from "@supatype/types"

export type Doc = Model<{
  id: UUID
  summary: Computed<Optional<string>>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const doc = ast?.models.find((m) => m.name === "Doc")
    expect(doc?.fields["summary"]).toMatchObject({
      kind: "text",
      required: false,
      readOnly: true,
      serverGenerated: true,
    })
  })

  it("extracts ComputedFrom sources on text (single + tuple)", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-computed-from-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, ComputedFrom, Optional } from "@supatype/types"

export type Article = Model<{
  id: UUID
  title: string
  subtitle: string
  excerpt: Optional<ComputedFrom<string, "title">>
  teaser: Optional<ComputedFrom<string, readonly ["title", "subtitle"]>>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const article = ast?.models.find((m) => m.name === "Article")
    expect(article?.fields["excerpt"]).toMatchObject({
      kind: "text",
      required: false,
      sources: ["title"],
    })
    expect(article?.fields["teaser"]).toMatchObject({
      kind: "text",
      required: false,
      sources: ["title", "subtitle"],
    })
  })

  it("extracts ComputedFrom template string and inferred sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-computed-tpl-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, ComputedFrom, Optional } from "@supatype/types"

export type Note = Model<{
  id: UUID
  title: string
  author: string
  published_at: string
  description: string
  summary: Optional<ComputedFrom<string, "Author: {author} | Date: {published_at}\\n{truncate(description, 100)}">>
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const note = ast?.models.find((m) => m.name === "Note")
    const summary = note?.fields["summary"] as { sources?: string[]; template?: string } | undefined
    expect(summary).toMatchObject({
      kind: "text",
      required: false,
      template: "Author: {author} | Date: {published_at}\n{truncate(description, 100)}",
    })
    expect(new Set(summary?.sources ?? [])).toEqual(new Set(["author", "published_at", "description"]))
  })
})
