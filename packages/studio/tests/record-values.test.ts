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
    versioning: false,
    softDelete: false,
    timestamps: false,
    hasHooks: false,
  }) as ModelConfig

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
