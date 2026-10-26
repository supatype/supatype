import { describe, expect, it } from "vitest"
import { serializeRecordForApi } from "../src/lib/recordValues.js"
import type { FieldConfig, ModelConfig } from "../src/config.js"

// Postgres does not agree that `''` is missing: `char_length('') >= 5` is false, while the same
// check against NULL is NULL and passes. Studio's validator treats a blank optional field as absent,
// so the two agree only if blanks reach the API as NULL. That used to depend on every text widget
// remembering to convert on change; these tests pin it to one place instead.

const field = (over: Partial<FieldConfig> & Pick<FieldConfig, "name">): FieldConfig => ({
  label: over.name,
  widget: "text",
  required: false,
  localized: false,
  ...over,
})

const model = (fields: FieldConfig[]): ModelConfig =>
  ({
    name: "Post",
    label: "Post",
    labelPlural: "Posts",
    tableName: "posts",
    apiPath: "/posts",
    primaryKey: "id",
    fields,
    listColumns: [],
    searchFields: [],
    publishable: false,
    versions: null,
    softDelete: false,
    timestamps: false,
    hasHooks: false,
  })

describe("serializeRecordForApi: blank normalisation", () => {
  it("sends a blank text field as null, not an empty string", () => {
    const out = serializeRecordForApi(model([field({ name: "summary" })]), { summary: "" })
    expect(out["summary"]).toBeNull()
  })

  it("nulls a blank translation without disturbing the others", () => {
    const out = serializeRecordForApi(
      model([field({ name: "title", localized: true })]),
      { title: { en: "Hello", fr: "" } },
    )
    expect(out["title"]).toEqual({ en: "Hello", fr: null })
  })

  it("leaves a JSON field's empty string alone, where blank is a value", () => {
    const out = serializeRecordForApi(model([field({ name: "meta", widget: "json" })]), {
      meta: "",
    })
    expect(out["meta"]).toBe("")
  })

  it("does not confuse an empty collection with a blank string", () => {
    const out = serializeRecordForApi(model([field({ name: "tags" })]), { tags: [] })
    expect(out["tags"]).toEqual([])
  })

  it("still maps relations to their foreign-key column", () => {
    const out = serializeRecordForApi(
      model([
        field({
          name: "author",
          widget: "relation",
          options: { cardinality: "belongsTo", foreignKey: "author_id" },
        }),
      ]),
      { author: "abc" },
    )
    expect(out).toEqual({ author_id: "abc" })
  })
})

/**
 * A blank slug is sent as one made from its source field, never as null.
 *
 * The engine's slug trigger fills an empty slug from its source only on INSERT. On UPDATE it leaves
 * an empty slug empty, so a slug cleared in the editor reached the table as NULL and the save (or,
 * on a drafts model, the publish that copied the draft into the live row) failed with `null value in
 * column "slug" ... violates not-null constraint`. Studio now makes the slug the trigger would have.
 */
describe("serializeRecordForApi: blank slugs", () => {
  const slugged = (from: FieldConfig): ModelConfig =>
    model([from, field({ name: "slug", widget: "slug", required: true, options: { from: from.name } })])

  it("makes a cleared slug from its source field", () => {
    const out = serializeRecordForApi(slugged(field({ name: "name" })), { name: "Ada Lovelace", slug: "" })
    expect(out["slug"]).toBe("ada-lovelace")
  })

  it("makes a slug the form never held from its source field", () => {
    const out = serializeRecordForApi(slugged(field({ name: "name" })), { name: "Grace Hopper", slug: null })
    expect(out["slug"]).toBe("grace-hopper")
  })

  it("makes it from the first translation of a localized source", () => {
    const source = field({ name: "title", localized: true })
    const out = serializeRecordForApi(slugged(source), { title: { en: "Hello World", fr: "Bonjour" }, slug: null })
    expect(out["slug"]).toBe("hello-world")
  })

  it("keeps a slug the editor typed", () => {
    const out = serializeRecordForApi(slugged(field({ name: "name" })), { name: "Ada", slug: "the-countess" })
    expect(out["slug"]).toBe("the-countess")
  })

  it("leaves it null when the source is blank too, for the required check to report", () => {
    const out = serializeRecordForApi(slugged(field({ name: "name" })), { name: "", slug: "" })
    expect(out["slug"]).toBeNull()
  })

  it("adds no slug to a write that does not touch it", () => {
    const out = serializeRecordForApi(slugged(field({ name: "name" })), { name: "Ada" })
    expect("slug" in out).toBe(false)
  })
})
