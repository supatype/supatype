import { describe, expect, it } from "vitest"
import { exampleRecord } from "../src/lib/api-examples.js"
import { testField } from "./support.js"

/**
 * Fresh-test cosmetic: the model API tab's example response showed a post's `tags` and `comments`
 * as UUID strings and its `cover` image and rich text `body` as plain strings. A has-many or
 * many-to-many relation is no column of the row, an image is a storage reference and rich text is a
 * document, so the examples now show those shapes.
 */

const FIELDS = [
  testField({ name: "author_id", widget: "relation", options: { target: "author", cardinality: "belongsTo" } }),
  testField({ name: "tags", widget: "multirelation", options: { target: "tag", cardinality: "manyToMany" } }),
  testField({ name: "comments", widget: "multirelation", options: { target: "comment", cardinality: "hasMany" } }),
  testField({ name: "cover", widget: "image", options: { bucket: "images" } }),
  testField({ name: "body", widget: "richtext" }),
]

describe("the API docs' example rows", () => {
  it("leave out relations the row holds no column for", () => {
    const row = exampleRecord(FIELDS)
    expect(row).not.toHaveProperty("tags")
    expect(row).not.toHaveProperty("comments")
    expect(typeof row["author_id"]).toBe("string")
  })

  it("show an image as its storage reference and rich text as a document", () => {
    const row = exampleRecord(FIELDS)
    expect(row["cover"]).toEqual({ bucket: "images", path: "example/cover.png", mimeType: "image/png", size: 48213 })
    expect(row["body"]).toMatchObject({ root: { type: "root" } })
  })
})
