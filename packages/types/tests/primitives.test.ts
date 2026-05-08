import { describe, expectTypeOf, it } from "vitest"
import type {
  Block,
  Blocks,
  HasMany,
  Model,
  Optional,
  RichText,
  ServerDefault,
  Slug,
  UUID,
  Unique,
  JSON,
  Public,
  Owner,
  RelatedTo,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  OwnerFrom,
  EditorReadOnly,
  Computed,
} from "../src/index.js"
import type { SerializedEditorState } from "../src/lexical.js"

type User = Model<{
  id: UUID
  email: Unique<string>
}>

type Post = Model<{
  id: UUID
  author_id: UUID
  slug: Unique<Slug>
  body: RichText
  metadata: JSON<{ draft: boolean }>
  author: User
  comments: HasMany<Comment>
}, {
  access: { read: Public; update: Owner<"author_id"> }
}>

type Comment = Model<{
  id: UUID
  body: string
  post: Post
  deletedAt: Optional<Date>
}>

type Hero = Block<"hero", { heading: string; ctaUrl?: string }>
type RichTextSection = Block<"rich_text", { content: RichText }>
type LandingPage = Model<{
  id: UUID
  content: Blocks<Hero | RichTextSection>
}>

describe("@supatype/types primitives", () => {
  it("exposes branded field types with structural use-site compatibility", () => {
    expectTypeOf<Post["id"]>().toMatchTypeOf<string>()
    expectTypeOf<Post["slug"]>().toMatchTypeOf<string>()
    expectTypeOf<Post["metadata"]>().toMatchTypeOf<{ draft: boolean }>()
  })

  it("RichText accepts Lexical state or plain string (fixtures / gradual adoption)", () => {
    expectTypeOf<"hello">().toMatchTypeOf<RichText>()
    const lexical: SerializedEditorState = { root: { type: "root", version: 1, children: [] } }
    expectTypeOf(lexical).toMatchTypeOf<RichText>()
  })

  it("supports relation wrappers and optional modifier composition", () => {
    expectTypeOf<Post["comments"]>().toEqualTypeOf<Comment[]>()
    expectTypeOf<Comment["deletedAt"]>().toEqualTypeOf<Date | null | undefined>()
  })

  it("supports block unions for block-based content fields", () => {
    expectTypeOf<LandingPage["content"]>().toEqualTypeOf<(Hero | RichTextSection)[]>()
  })

  it("preserves model metadata markers for extractor discovery", () => {
    expectTypeOf<Post>().toHaveProperty("id")
    expectTypeOf<Post>().toHaveProperty("body")
  })

  it("validates Owner<> keys against model fields when model is provided", () => {
    type Valid = Owner<Post, "author_id">
    expectTypeOf<Valid>().toMatchTypeOf<Owner<Post, "author_id">>()

    // @ts-expect-error - key must exist on Post fields
    type Invalid = Owner<Post, "authorId">
    expectTypeOf<Invalid>().toBeNever()
  })

  it("infers current model field keys in Model access metadata", () => {
    type Inferred = Model<{
      id: UUID
      author_id: UUID
    }, {
      access: {
        update: Owner<"author_id">
      }
    }>

    expectTypeOf<Inferred>().toHaveProperty("id")

    // @ts-expect-error - authorId is not a field on this model
    type Bad = Model<{
      id: UUID
      author_id: UUID
    }, {
      access: {
        update: Owner<"authorId">
      }
    }>
    expectTypeOf<Bad>().toBeNever()
  })

  it("allows self-referential ownership via primary id", () => {
    type SelfOwned = Model<{
      id: SupatypeAuthUserId
      name: string
    }, {
      access: {
        update: Owner<"id">
        delete: Owner<"id">
      }
    }>

    expectTypeOf<SelfOwned>().toHaveProperty("id")
  })

  it("rejects Owner<\"id\"> when id is not explicitly auth user id", () => {
    // @ts-expect-error - id must be SupatypeAuthUserId for Owner<"id">
    type BadSelfOwned = Model<{
      id: UUID
      name: string
    }, {
      access: {
        update: Owner<"id">
      }
    }>
    expectTypeOf<BadSelfOwned>().toBeNever()
  })

  it("rejects orphan *_id owner keys that are not relation-backed", () => {
    // @ts-expect-error - author_id exists but has no RelatedTo<...> backing field
    type InvalidOwnerField = Model<{
      id: UUID
      author_id: UUID
      title: string
    }, {
      access: {
        update: Owner<"author_id">
      }
    }>

    expectTypeOf<InvalidOwnerField>().toBeNever()
  })

  it("rejects Owner<Model,...> when model does not match current model", () => {
    // @ts-expect-error - cannot use User model owner marker in Post model access
    type WrongModelOwner = Model<{
      id: UUID
      author: RelatedTo<User>
    }, {
      access: {
        update: Owner<User, "id">
      }
    }>

    expectTypeOf<WrongModelOwner>().toBeNever()
  })

  it("supports OwnerFrom<relationField> for camelCase relation ownership", () => {
    type Owned = Model<{
      id: UUID
      authUser: RelatedTo<SupatypeAuthUser>
    }, {
      access: {
        update: OwnerFrom<"authUser">
      }
    }>

    expectTypeOf<Owned>().toHaveProperty("authUser")

    // @ts-expect-error - must reference an actual relation field name
    type Bad = Model<{
      id: UUID
      authUser: RelatedTo<SupatypeAuthUser>
    }, {
      access: {
        update: OwnerFrom<"auth_user_id">
      }
    }>
    expectTypeOf<Bad>().toBeNever()
  })

  it("treats ServerDefault as string at the value boundary for timestamps", () => {
    type Row = { publishedAt: ServerDefault<string> }
    expectTypeOf<Row["publishedAt"]>().toMatchTypeOf<string>()
  })

  it("preserves EditorReadOnly wrapper at type boundary", () => {
    type Row = { title: EditorReadOnly<string> }
    expectTypeOf<Row["title"]>().toMatchTypeOf<string>()
  })

  it("preserves Computed wrapper at type boundary", () => {
    type Row = { summary: Computed<string> }
    expectTypeOf<Row["summary"]>().toMatchTypeOf<string>()
  })
})
