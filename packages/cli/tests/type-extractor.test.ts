import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ModelAstV2 } from "../src/schema-ast-v2.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

function tableName(model: ModelAstV2 | undefined): string | undefined {
  return model?.annotations.db.tableName
}

function modelAccess(model: ModelAstV2 | undefined): Record<string, unknown> {
  return model?.annotations.platform.access ?? {}
}

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
    expect(ast?.astVersion).toBe(2)
    expect(ast?.models).toHaveLength(2)
    const post = ast?.models.find((m) => m.name === "Post")
    const comment = ast?.models.find((m) => m.name === "Comment")
    expect(tableName(post)).toBe("post")
    expect(comment?.fields["post"]).toMatchObject({
      kind: "relation",
      cardinality: "belongsTo",
      target: "Post",
      annotations: { db: { foreignKey: "post_id" } },
    })
    expect(post?.fields["id"]).toMatchObject({
      kind: "uuid",
      annotations: { db: { pgType: "UUID", unique: true } },
      primaryKey: true,
      required: true,
      default: { kind: "genRandomUuid" },
    })
    expect(post?.fields["slug"]).toMatchObject({
      kind: "slug",
      from: "title",
      annotations: { db: { unique: true } },
    })
    expect(modelAccess(post)["read"]).toEqual({ type: "public" })
    expect(modelAccess(post)["update"]).toEqual({ type: "owner", field: "author_id" })
    expect(modelAccess(post)["delete"]).toEqual({ type: "owner", field: "author_id" })
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
      annotations: { db: { serverGenerated: true, pgType: "TIMESTAMP WITH TIME ZONE" } },
      default: { kind: "now" },
    })
    expect(entry?.fields["updated_at"]).toMatchObject({
      kind: "datetime",
      annotations: { db: { serverGenerated: true, pgType: "TIMESTAMP WITH TIME ZONE" } },
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
    expect(modelAccess(user)["update"]).toEqual({ type: "owner", field: "id" })
    expect(modelAccess(user)["delete"]).toEqual({ type: "owner", field: "id" })
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
      annotations: { db: { foreignKey: "auth_user_id" } },
    })
    expect(modelAccess(post)["update"]).toEqual({ type: "owner", field: "authUser" })
    expect(modelAccess(post)["delete"]).toEqual({ type: "owner", field: "authUser" })
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
    expect(ast?.models[0]?.fields["isActive"]).toMatchObject({
      kind: "boolean",
      annotations: { db: { pgType: "BOOLEAN" } },
      default: { kind: "value", value: true },
    })
  })

  it("extracts Default<> literal values for scalars and RichText plain-string defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-defaults-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Default, Int, RichText } from "@supatype/types"

export type Product = Model<{
  id: UUID
  stock: Default<Int, 0>
  blurb: Default<RichText, "Welcome to our shop.">
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.models[0]?.fields["stock"]).toMatchObject({
      kind: "integer",
      default: { kind: "value", value: 0 },
    })
    expect(ast?.models[0]?.fields["blurb"]).toMatchObject({
      kind: "richText",
      annotations: { db: { pgType: "JSONB" }, platform: { editor: "rich" } },
      default: { kind: "value", value: "Welcome to our shop." },
    })
  })

  it("extracts RichText<\"…\"> inline default (equivalent to Default<RichText, \"…\">)", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-richtext-inline-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, RichText } from "@supatype/types"

export type Page = Model<{
  id: UUID
  intro: RichText<"Welcome to Elmside.">
}>
`,
      "utf8",
    )
    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.models[0]?.fields["intro"]).toMatchObject({
      kind: "richText",
      annotations: { db: { pgType: "JSONB" }, platform: { editor: "rich" } },
      default: { kind: "value", value: "Welcome to Elmside." },
    })
  })

  it("errors when RichText inline default and Default<> are both set", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-richtext-double-default-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Default, RichText } from "@supatype/types"

export type Page = Model<{
  id: UUID
  intro: Default<RichText<"a">, "b">
}>
`,
      "utf8",
    )
    expect(() => extractSchemaAstFromTypes(schemaPath, dir)).toThrow(
      /either Default<…> or an inline type default/,
    )
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
    expect(comment?.fields["author"]).toMatchObject({
      annotations: { db: { foreignKey: "author_id" } },
    })
    expect(comment?.fields["userId"]).toMatchObject({
      annotations: { db: { foreignKey: "user_id" } },
    })
    expect(comment?.fields["customerID"]).toMatchObject({
      annotations: { db: { foreignKey: "customer_id" } },
    })
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
    expect(doc?.fields["title"]).toMatchObject({
      kind: "text",
      annotations: { platform: { readOnly: true } },
    })
    expect(doc?.fields["owner"]).toMatchObject({
      kind: "relation",
      annotations: { platform: { readOnly: true } },
    })
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
      annotations: { db: { serverGenerated: true }, platform: { readOnly: true } },
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

  it("extracts singleton: true with default _global_ table name", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-singleton-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Public, Role, Timestamp } from "@supatype/types"

export type SiteSettings = Model<{
  id: UUID
  site_name: string
  created_at: Timestamp
  updated_at: Timestamp
}, {
  singleton: true
  access: { read: Public; update: Role<"supatype_admin"> }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const settings = ast?.models.find((m) => m.name === "SiteSettings")
    expect(tableName(settings)).toBe("_global_site_settings")
    expect(settings?.options).toMatchObject({ singleton: true, timestamps: true })
  })

  it("respects tableName override on singleton models", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-singleton-table-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Public } from "@supatype/types"

export type Config = Model<{
  id: UUID
}, {
  singleton: true
  tableName: "config"
  access: { read: Public }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const config = ast?.models.find((m) => m.name === "Config")
    expect(tableName(config)).toBe("config")
    expect(config?.options.singleton).toBe(true)
  })

  it("infers timestamps from WithTimestamps wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-timestamps-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, WithTimestamps, Public } from "@supatype/types"

export type Post = Model<WithTimestamps<{
  id: UUID
  title: string
}>, {
  access: { read: Public }
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const post = ast?.models.find((m) => m.name === "Post")
    expect(post?.options.timestamps).toBe(true)
    expect(post?.options.singleton).toBeUndefined()
  })

  it("extracts LocaleConfig into schema AST locales", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-locale-config-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { LocaleConfig, Model, UUID } from "@supatype/types"

export type localeConfig = LocaleConfig<["en", "de"], "en">

export type Page = Model<{ id: UUID; title: string }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.locales).toEqual(["en", "de"])
    expect(ast?.defaultLocale).toBe("en")
  })

  it("marks Localized fields as JSONB with localized:true", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-localized-field-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Localized, Model, Optional, RichText, UUID } from "@supatype/types"

export type Page = Model<{
  id: UUID
  title: Localized<string>
  body: Localized<RichText>
  subtitle: Optional<Localized<string>>
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const page = ast?.models.find((m) => m.name === "Page")
    expect(page?.fields["title"]).toMatchObject({
      kind: "text",
      annotations: { db: { pgType: "JSONB" } },
      localized: true,
      required: true,
    })
    expect(page?.fields["body"]).toMatchObject({
      kind: "richText",
      annotations: { db: { pgType: "JSONB" }, platform: { editor: "rich" } },
      localized: true,
    })
    expect(page?.fields["subtitle"]).toMatchObject({
      kind: "text",
      annotations: { db: { pgType: "JSONB" } },
      localized: true,
      required: false,
    })
  })

  it("extracts LocalizedModel with auto-localized copy fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-localized-model-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type {
  LocalizedModel,
  UUID,
  ImageAsset,
  NotLocalized,
  Blocks,
  Block,
  Bucket,
} from "@supatype/types"

export type marketing = Bucket<"marketing", { accessMode: "public" }>
export type RuleBlock = Block<"rule", { text: string }>

export type Homepage = LocalizedModel<{
  id: UUID
  hero_title: string
  map_url: NotLocalized<string>
  og_image: ImageAsset<marketing, { localized: true }>
  hero_slides: Blocks<RuleBlock>
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const homepage = ast?.models.find((m) => m.name === "Homepage")
    expect(homepage?.fields["hero_title"]).toMatchObject({
      kind: "text",
      localized: true,
      annotations: { db: { pgType: "JSONB" } },
    })
    expect(homepage?.fields["map_url"]?.localized).toBeUndefined()
    expect(homepage?.fields["og_image"]).toMatchObject({
      kind: "image",
      localized: true,
    })
    const slides = homepage?.fields["hero_slides"] as { blocks?: { fields: Record<string, unknown> }[] }
    expect(slides?.blocks?.[0]?.fields["text"]).toMatchObject({
      kind: "text",
      localized: true,
      pgType: "JSONB",
    })
  })

  it("marks Localized<Blocks<...>> as localized column", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-localized-blocks-col-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Localized, Model, UUID, Blocks, Block } from "@supatype/types"

export type Slide = Block<"slide", { image_path: string }>

export type Page = Model<{
  id: UUID
  slides: Localized<Blocks<Slide>>
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const page = ast?.models.find((m) => m.name === "Page")
    expect(page?.fields["slides"]).toMatchObject({
      kind: "blocks",
      localized: true,
      annotations: { db: { pgType: "JSONB" } },
    })
  })

  it("resolves type alias Nullable<T> = Optional<T>", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-alias-nullable-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email, Optional } from "@supatype/types"

type Nullable<T> = Optional<T>

export type User = Model<{
  id: UUID
  email: Nullable<Email>
}>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves multi-hop type aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-alias-multihop-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email, Optional } from "@supatype/types"

type Nullable<T> = Optional<T>
type A = Nullable<Email>
type B = A

export type User = Model<{ id: UUID; email: B }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves enum string-union type aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-alias-enum-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID } from "@supatype/types"

type Status = "draft" | "published" | "archived"

export type Post = Model<{ id: UUID; status: Status }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    expect(ast?.models[0]?.fields["status"]).toMatchObject({
      kind: "enum",
      values: ["draft", "published", "archived"],
    })
  })

  it("resolves import renames of @supatype/types primitives", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-import-rename-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email, Optional as Maybe } from "@supatype/types"

export type User = Model<{ id: UUID; email: Maybe<Email> }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves cross-file type aliases via local import", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-cross-file-alias-"))
    dirs.push(dir)
    writeFileSync(
      join(dir, "field-types.ts"),
      `
import type { Optional } from "@supatype/types"

export type Nullable<T> = Optional<T>
`,
      "utf8",
    )
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email } from "@supatype/types"
import type { Nullable } from "./field-types"

export type User = Model<{ id: UUID; email: Nullable<Email> }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves import rename of a local type alias", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-rename-local-alias-"))
    dirs.push(dir)
    writeFileSync(
      join(dir, "field-types.ts"),
      `
import type { Optional } from "@supatype/types"

export type Nullable<T> = Optional<T>
`,
      "utf8",
    )
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email } from "@supatype/types"
import type { Nullable as MaybeNull } from "./field-types"

export type User = Model<{ id: UUID; email: MaybeNull<Email> }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves conditional type aliases via type checker", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-conditional-alias-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email, Optional } from "@supatype/types"

type NullableStr<T> = T extends string ? Optional<T> : T

export type User = Model<{ id: UUID; email: NullableStr<Email> }>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({
      kind: "email",
      required: false,
    })
  })

  it("resolves mapped type aliases as Model fields argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-mapped-fields-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID, Email, Optional } from "@supatype/types"

type AllOptional<T> = { [K in keyof T]: Optional<T[K]> }

export type User = Model<AllOptional<{ email: Email; name: string }>>
`,
      "utf8",
    )

    const ast = extractSchemaAstFromTypes(schemaPath, dir)
    const user = ast?.models.find((m) => m.name === "User")
    expect(user?.fields["email"]).toMatchObject({ kind: "email", required: false })
    expect(user?.fields["name"]).toMatchObject({ kind: "text", required: false })
  })

  it("throws on unknown Supatype types instead of silently mapping to TEXT", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-unknown-type-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID } from "@supatype/types"

export type User = Model<{ id: UUID; email: SomeType }>
`,
      "utf8",
    )

    expect(() => extractSchemaAstFromTypes(schemaPath, dir)).toThrow(/Unknown Supatype type "SomeType"/)
  })

  it("throws on circular type alias chains", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-circular-alias-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID } from "@supatype/types"

type A = B
type B = A

export type User = Model<{ id: UUID; email: A }>
`,
      "utf8",
    )

    expect(() => extractSchemaAstFromTypes(schemaPath, dir)).toThrow(/circular alias chain/)
  })

  it("throws on TypeScript utility types used as field types", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-utility-type-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
import type { Model, UUID } from "@supatype/types"

export type User = Model<{ id: UUID; email: NonNullable<string> }>
`,
      "utf8",
    )

    expect(() => extractSchemaAstFromTypes(schemaPath, dir)).toThrow(/Unknown Supatype type "NonNullable"/)
  })
})
