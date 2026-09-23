import { describe, expectTypeOf, it } from "vitest"
import type { Localized, Model, Optional, UUID } from "../src/index.js"

/**
 * Reading a modifier-wrapped field off a row type.
 *
 * This was `TS2589: Type instantiation is excessively deep and possibly infinite` for *any* `Optional`
 * field: not an exotic case: `post.nick` on a model with one optional column. A brand is an
 * intersection carrying an optional phantom property, so every type structurally satisfies
 * `Modifier<Name, infer _>`; unwrapping one level produced the inner type, which still reported as a
 * modifier, so the unwrap never reached a fixed point.
 *
 * These read as ordinary assertions about the row shape, which is the point, a type nobody can index
 * into is not a type users have.
 */
type Post = Model<{
  id: UUID
  nick: Optional<string>
  title: Localized<string>
  subtitle: Optional<Localized<string>>
}>

describe("modifier unwrapping", () => {
  it("reads a required field", () => {
    expectTypeOf<Post["id"]>().toExtend<string>()
  })

  it("reads an Optional field, which used to make the compiler give up", () => {
    expectTypeOf<Post["nick"]>().toExtend<string | null | undefined>()
  })

  it("reads a Localized field as a locale-keyed record", () => {
    expectTypeOf<Post["title"]>().toExtend<Record<string, string>>()
  })

  it("reads a stacked Optional<Localized<…>> field", () => {
    // Two levels, which is what the bound has to allow: the fix caps the unwrap rather than removing
    // the recursion, so a legitimate stack has to keep working.
    expectTypeOf<Post["subtitle"]>().toExtend<Record<string, string> | null | undefined>()
  })
})
