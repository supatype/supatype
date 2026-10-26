import { describe, expect, it } from "vitest"
import { junctionTablesOf } from "../src/augmentation-relationships.js"
import type { AstModel } from "../src/augmentation-generator.js"

/**
 * Fresh-user test B6, the client side. The engine now names a derived many-to-many junction from
 * the two TABLE names, sorted and lowercase (`post_tag`), with its ends and foreign key columns in
 * that sorted order, so both sides and either declaration order share one junction. The client's
 * types used the old formula (one side's table plus the other side's model name), which named
 * tables the database no longer has: `Post_tag` and `Tag_post`.
 */
const model = (name: string, table: string, target: string): AstModel => ({
  name,
  fields: {
    id: { kind: "uuid", required: true, primaryKey: true },
    [`${target.toLowerCase()}s`]: { kind: "relation", cardinality: "manyToMany", target },
  },
  annotations: { db: { tableName: table, indexes: [] } },
})

const tableName = (m: AstModel): string =>
  String((m.annotations as { db?: { tableName?: string } } | undefined)?.db?.tableName ?? m.name)

const junctions = (models: AstModel[]) => junctionTablesOf({ models, tableName, tsOf: () => "string" })

describe("derived many-to-many junction", () => {
  it("is one post_tag from both sides, in either declaration order", () => {
    for (const models of [
      [model("Post", "post", "Tag"), model("Tag", "tag", "Post")],
      [model("Tag", "tag", "Post"), model("Post", "post", "Tag")],
    ]) {
      const found = junctions(models)
      expect(found.map((j) => j.name)).toEqual(["post_tag"])
      expect(found[0]?.columns.map((c) => c.column)).toEqual(["post_id", "tag_id"])
      expect(found[0]?.relationships.map((r) => r.referencedRelation)).toEqual(["post", "tag"])
    }
  })

  it("sorts by table name, not model name", () => {
    const found = junctions([model("Article", "zeta_articles", "Label"), model("Label", "alpha_labels", "Article")])
    expect(found.map((j) => j.name)).toEqual(["alpha_labels_zeta_articles"])
    expect(found[0]?.columns.map((c) => c.column)).toEqual(["label_id", "article_id"])
  })
})
