import { describe, expectTypeOf, it } from "vitest"
import type {
  Block,
  Blocks,
  Computed,
  EditorReadOnly,
  HasMany,
  JSON,
  Model,
  Optional,
  Owner,
  OwnerFrom,
  Public,
  RelatedTo,
  RichText,
  ServerDefault,
  Slug,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  UUID,
  Unique,
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
  // `RelatedTo`, not a bare field: `author_id` is owner-eligible only because a relation named `author`
  // is declared here. A plain column of that name is not enough, which several tests below pin.
  author: RelatedTo<SupatypeAuthUser>
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
    expectTypeOf<Post["id"]>().toExtend<string>()
    expectTypeOf<Post["slug"]>().toExtend<string>()
    expectTypeOf<Post["metadata"]>().toExtend<{ draft: boolean }>()
  })

  it("RichText accepts Lexical state or plain string (fixtures / gradual adoption)", () => {
    expectTypeOf<"hello">().toExtend<RichText>()
    const lexical: SerializedEditorState = { root: { type: "root", version: 1, children: [] } }
    expectTypeOf(lexical).toExtend<RichText>()
  })

  it("supports relation wrappers and optional modifier composition", () => {
    // `toExtend`, not `toEqualTypeOf`: a relation keeps its tag on the row, so the type is `Comment[]`
    // wearing a label rather than bare `Comment[]`. What callers need is that it reads as the array.
    expectTypeOf<Post["comments"]>().toExtend<readonly Comment[]>()
    expectTypeOf<Comment["deletedAt"]>().toEqualTypeOf<Date | null | undefined>()
  })

  it("supports block unions for block-based content fields", () => {
    expectTypeOf<LandingPage["content"]>().toExtend<readonly (Hero | RichTextSection)[]>()
  })

  it("preserves model metadata markers for extractor discovery", () => {
    expectTypeOf<Post>().toHaveProperty("id")
    expectTypeOf<Post>().toHaveProperty("body")
  })

  it("validates Owner<> keys against model fields when model is provided", () => {
    type Valid = Owner<Post, "author_id">
    expectTypeOf<Valid>().toExtend<Owner<Post, "author_id">>()

    // The directive *is* the assertion: a rejected type argument is a compile error, and reading the
    // suppressed type afterwards yields the rule itself rather than `never`.
    // @ts-expect-error - "authorId" is not `${relation}_id` for any declared relation
    type _Invalid = Owner<Post, "authorId">
  })

  it("infers owner keys from the model's own relations in inline access metadata", () => {
    type Inferred = Model<{
      id: UUID
      author_id: UUID
      author: RelatedTo<SupatypeAuthUser>
    }, {
      access: { update: Owner<"author_id"> }
    }>

    expectTypeOf<Inferred>().toHaveProperty("id")

    // @ts-expect-error - "authorId" is not a relation-backed owner key on this model
    type _Bad = Model<{ id: UUID; author: RelatedTo<SupatypeAuthUser> }, { access: { update: Owner<"authorId"> } }>
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
    type _BadSelfOwned = Model<{ id: UUID; name: string }, { access: { update: Owner<"id"> } }>
  })

  it("rejects orphan *_id owner keys that are not relation-backed", () => {
    // The counterpart to the inline test above, and the reason it now declares a relation: a bare
    // `author_id` column tells the type system nothing about whose id it holds.
    // @ts-expect-error - author_id exists but has no RelatedTo<...> backing field
    type _Orphan = Model<{ id: UUID; author_id: UUID; title: string }, { access: { update: Owner<"author_id"> } }>
  })

  it("rejects Owner<Model,...> when model does not match current model", () => {
    // @ts-expect-error - cannot use the User model's owner marker in another model's access
    type _WrongModelOwner = Model<{ id: UUID; author: RelatedTo<User> }, { access: { update: Owner<User, "id"> } }>
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

    // @ts-expect-error - must reference an actual relation field name, not its column
    type _Bad = Model<{ id: UUID; authUser: RelatedTo<SupatypeAuthUser> }, { access: { update: OwnerFrom<"auth_user_id"> } }>
  })

  // The three below used to assert that a modifier is transparent in a bare type literal —
  // `ServerDefault<string>` was structurally a string. That was the accident behind three defects, so a
  // modifier is now a declaration wrapper: it is the *row* that reads as a string, which is what a
  // caller actually holds. The intent is unchanged; the subject is the model rather than the literal.
  it("treats ServerDefault as string on the row it produces", () => {
    type M = Model<{ publishedAt: ServerDefault<string> }>
    expectTypeOf<M["publishedAt"]>().toExtend<string>()
  })

  it("treats EditorReadOnly as its inner type on the row", () => {
    type M = Model<{ title: EditorReadOnly<string> }>
    expectTypeOf<M["title"]>().toExtend<string>()
  })

  it("treats Computed as its inner type on the row", () => {
    type M = Model<{ summary: Computed<string> }>
    expectTypeOf<M["summary"]>().toExtend<string>()
  })
})
