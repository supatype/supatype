import { describe, expect, it } from "vitest"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"

/**
 * Studio renders its list-view search box only when a model has `searchFields`, and filters on the
 * first of them. Everything upstream of that — `Searchable<T>` in the schema, the extractor, the
 * engine's admin config — exists to put a name in that array.
 *
 * It was inert end to end: the extractor unwrapped `Searchable` and set no flag, so the engine was
 * told nothing, so this normalizer read no `searchFields`, so no model ever had a search box. These
 * cases pin the half that lives here.
 */
function config(model: Record<string, unknown>): ReturnType<typeof normalizeAdminConfig> {
  return normalizeAdminConfig({ models: [{ name: "Article", tableName: "article", ...model }] })
}

describe("searchFields", () => {
  it("takes the engine's list as given, order included", () => {
    const admin = config({
      searchFields: ["title", "subtitle"],
      fields: [
        { name: "title", widget: "text" },
        { name: "subtitle", widget: "text" },
      ],
    })
    expect(admin.models[0]?.searchFields).toEqual(["title", "subtitle"])
  })

  it("falls back to the fields' own flags when no list is supplied", () => {
    const admin = config({
      fields: [
        { name: "title", widget: "text", searchable: true },
        { name: "views", widget: "number" },
        { name: "summary", widget: "text", searchable: true },
      ],
    })
    // A schema that only marks fields still gets a search box.
    expect(admin.models[0]?.searchFields).toEqual(["title", "summary"])
  })

  it("carries the per-field flag through", () => {
    const admin = config({ fields: [{ name: "title", widget: "text", searchable: true }] })
    expect(admin.models[0]?.fields[0]?.searchable).toBe(true)
  })

  it("leaves a model with nothing searchable with no search box", () => {
    const admin = config({ fields: [{ name: "views", widget: "number" }] })
    // Empty rather than undefined: ListView asks for `.length`.
    expect(admin.models[0]?.searchFields).toEqual([])
  })

  it("prefers an explicit empty list over the field flags", () => {
    const admin = config({
      searchFields: [],
      fields: [{ name: "title", widget: "text", searchable: true }],
    })
    // `searchable: []` on the model is a decision, not an absence: it turns search off.
    expect(admin.models[0]?.searchFields).toEqual([])
  })
})
