import { describe, expectTypeOf, it } from "vitest"
import type {
  AuthUserOnDelete,
  Model,
  Optional,
  Owner,
  RelatedTo,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  UUID,
} from "../src/index.js"

// An auth user id has no foreign key unless the field asks for one: `SupatypeAuthUserId<{ onDelete }>`.
describe("SupatypeAuthUserId<{ onDelete }>", () => {
  it("takes the three delete behaviours, and nothing else", () => {
    expectTypeOf<AuthUserOnDelete>().toEqualTypeOf<"cascade" | "restrict" | "setNull">()
    expectTypeOf<SupatypeAuthUserId<{ onDelete: "cascade" }>>().toExtend<string>()
    expectTypeOf<SupatypeAuthUserId<{ onDelete: "restrict" }>>().toExtend<string>()
    expectTypeOf<Optional<SupatypeAuthUserId<{ onDelete: "setNull" }>>>().not.toBeNever()
    // Without options it is the field it always was, with no key.
    expectTypeOf<SupatypeAuthUserId>().toEqualTypeOf<SupatypeAuthUserId<{}>>()
    expectTypeOf<string>().toExtend<SupatypeAuthUserId<{ onDelete: "cascade" }>>()
  })

  it("rejects a behaviour or an option it does not take", () => {
    // @ts-expect-error "noAction" is not one of the delete behaviours
    type NoAction = SupatypeAuthUserId<{ onDelete: "noAction" }>
    // @ts-expect-error the behaviour is spelled setNull, as the schema spells options
    type SnakeCase = SupatypeAuthUserId<{ onDelete: "set_null" }>
    // @ts-expect-error an auth user id takes onDelete alone
    type Generated = SupatypeAuthUserId<{ generated: "gen_random_uuid()" }>
    // @ts-expect-error an auth user id takes onDelete alone, even beside it
    type Extra = SupatypeAuthUserId<{ onDelete: "cascade"; onUpdate: "cascade" }>
    // @ts-expect-error the options are an object
    type Bare = SupatypeAuthUserId<"cascade">
    expectTypeOf<[NoAction, SnakeCase, Generated, Extra, Bare]>().not.toBeNever()
  })

  it("is still an owner column, and RelatedTo<SupatypeAuthUser> is unchanged", () => {
    type Comment = Model<{
      id: UUID
      user_id: SupatypeAuthUserId<{ onDelete: "cascade" }>
      editor_id: Optional<SupatypeAuthUserId<{ onDelete: "setNull" }>>
      author: RelatedTo<SupatypeAuthUser>
      body: string
    }, {
      access: { update: Owner<"user_id">; delete: Owner<"editor_id"> }
    }>
    expectTypeOf<Comment["user_id"]>().toExtend<string>()
    expectTypeOf<Comment>().toHaveProperty("author")

    type Profile = Model<{ id: SupatypeAuthUserId<{ onDelete: "cascade" }>; name: string }, {
      access: { update: Owner<"id"> }
    }>
    expectTypeOf<Profile>().toHaveProperty("id")
  })
})
