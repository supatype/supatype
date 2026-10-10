import { describe, expectTypeOf, it } from "vitest"
import type {
  AutoIncrement,
  BigInt,
  Float,
  Generated,
  Identity,
  Int,
  Model,
  Optional,
  PrimaryKey,
  SmallInt,
  TSVector,
} from "../src/index.js"

// The options form is the root: `Int<{ identity }>`, `Float<{ generated }>`. The aliases resolve to
// exactly it, so a schema may use either and the two read the same everywhere.
describe("identity and generated columns", () => {
  it("resolves the aliases to the options form", () => {
    expectTypeOf<Identity<number>>().toEqualTypeOf<Int<{ identity: "always" }>>()
    expectTypeOf<Identity<bigint, "by-default">>().toEqualTypeOf<BigInt<{ identity: "by-default" }>>()
    expectTypeOf<Identity>().toEqualTypeOf<Int<{ identity: "always" }>>()
    expectTypeOf<AutoIncrement<number>>().toEqualTypeOf<Identity<number, "by-default">>()
    expectTypeOf<AutoIncrement<bigint>>().toEqualTypeOf<BigInt<{ identity: "by-default" }>>()
  })

  it("keeps the value type of the column", () => {
    expectTypeOf<Int<{ identity: "always" }>>().toExtend<number>()
    expectTypeOf<BigInt<{ identity: "by-default" }>>().toExtend<bigint>()
    expectTypeOf<Generated<string, "lower(name)">>().toExtend<string>()
    expectTypeOf<Float<{ generated: "price * qty" }>>().toExtend<number>()
    // A plain value is still assignable, as for every field type.
    expectTypeOf<number>().toExtend<Int<{ identity: "always" }>>()
    expectTypeOf<string>().toExtend<Generated<string, "lower(name)">>()
  })

  it("rejects options a type does not take", () => {
    // @ts-expect-error identity is for integer fields only
    type NotAnInteger = Float<{ identity: "always" }>
    // @ts-expect-error the modes are "always" and "by-default"
    type NoSuchMode = Int<{ identity: "sometimes" }>
    // @ts-expect-error an expression is SQL text
    type NotText = TSVector<{ generated: 1 }>
    // @ts-expect-error an identity column is an integer
    type NotNumbered = Identity<string>
    expectTypeOf<[NotAnInteger, NoSuchMode, NotText, NotNumbered]>().not.toBeNever()
  })

  it("reads as an ordinary column on the model's row", () => {
    type Post = Model<{
      id: PrimaryKey<Identity<number>>
      rank: SmallInt<{ identity: "by-default" }>
      title: string
      title_lower: Optional<Generated<string, "lower(title)">>
    }>
    expectTypeOf<Post["id"]>().toExtend<number>()
    expectTypeOf<Post["rank"]>().toExtend<number>()
    expectTypeOf<NonNullable<Post["title_lower"]>>().toExtend<string>()
  })
})
