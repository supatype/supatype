import { describe, expectTypeOf, it } from "vitest"
import type { HasMany, HasOne, Model, ManyToMany, RelatedTo, UUID } from "../src/index.js"

/**
 * Two models that name each other.
 *
 * These declarations are the test. `Model<F>` spreads `F` through a mapped type that probes every
 * field, and probing a relation used to expand the model it pointed at, so a `HasOne` facing its
 * `RelatedTo`, or a `RelatedTo` both ways, failed with `TS2589: Type instantiation is excessively
 * deep and possibly infinite`. A one-to-one relation was therefore inexpressible.
 *
 * Nothing at runtime can catch that, which is why this file is typechecked (`tsconfig.test.json`)
 * rather than only executed: a regression is a compile error here, not a failing assertion.
 */

// ── HasOne facing its RelatedTo ──────────────────────────────────────────────
type Settings = Model<{ id: UUID; theme: string; post: RelatedTo<Post> }>
type Post = Model<{ id: UUID; title: string; settings: HasOne<Settings> }>

// ── RelatedTo in both directions ─────────────────────────────────────────────
type Author = Model<{ id: UUID; featured: RelatedTo<Article> }>
type Article = Model<{ id: UUID; author: RelatedTo<Author> }>

// ── The collection cases, which always worked, kept so a fix cannot trade one for the other ──
type Comment = Model<{ id: UUID; body: string; post: RelatedTo<Blog> }>
type Tag = Model<{ id: UUID; name: string }>
type Blog = Model<{
  id: UUID
  comments: HasMany<Comment>
  tags: ManyToMany<Tag>
}>

describe("relation cycles", () => {
  it("resolves a model whose relation points back at it", () => {
    // Reaching the field at all is the assertion: an unresolvable cycle makes `Post` an error type.
    expectTypeOf<Post>().toHaveProperty("settings")
    expectTypeOf<Settings>().toHaveProperty("post")
    expectTypeOf<Article>().toHaveProperty("author")
    expectTypeOf<Author>().toHaveProperty("featured")
    expectTypeOf<Blog>().toHaveProperty("comments")
    expectTypeOf<Blog>().toHaveProperty("tags")
  })

  it("keeps the relation brand readable through the cycle", () => {
    expectTypeOf<Post["settings"]>().toExtend<{ readonly __relationKind: "hasOne" }>()
    expectTypeOf<Settings["post"]>().toExtend<{ readonly __relationKind: "relatedTo" }>()
    expectTypeOf<Blog["comments"]>().toExtend<{ readonly __relationKind: "hasMany" }>()
    expectTypeOf<Blog["tags"]>().toExtend<{ readonly __relationKind: "manyToMany" }>()
  })
})
