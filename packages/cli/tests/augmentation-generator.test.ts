import { describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"

describe("generateClientAugmentation", () => {
  it("emits deterministic output independent of model order", () => {
    const astA = {
      models: [
        {
          name: "Post",
          fields: { title: { kind: "text", required: true } },
          annotations: { db: { tableName: "post", indexes: [] } },
        },
        {
          name: "Comment",
          fields: { body: { kind: "text", required: true } },
          annotations: { db: { tableName: "comment", indexes: [] } },
        },
      ],
    }
    const astB = {
      models: [
        {
          name: "Comment",
          fields: { body: { kind: "text", required: true } },
          annotations: { db: { tableName: "comment", indexes: [] } },
        },
        {
          name: "Post",
          fields: { title: { kind: "text", required: true } },
          annotations: { db: { tableName: "post", indexes: [] } },
        },
      ],
    }

    expect(generateClientAugmentation(astA)).toEqual(generateClientAugmentation(astB))
    expect(generateClientAugmentation(astA)).toContain("post:")
    expect(generateClientAugmentation(astA)).toContain("comment:")
  })

  it("resolves tableName from AST v2 annotations.db.tableName", () => {
    const ast = {
      models: [
        {
          name: "Profile",
          fields: { id: { kind: "uuid", required: true } },
          annotations: { db: { tableName: "profile", indexes: [] } },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    expect(out).toContain("profile:")
    expect(out).not.toContain("undefined:")
  })

  it("falls back to snake_case model name when tableName is missing", () => {
    const ast = {
      models: [{ name: "Profile", fields: { id: { kind: "uuid", required: true } } }],
    }
    expect(generateClientAugmentation(ast)).toContain("profile:")
  })

  it("marks Insert fields optional when serverGenerated or default is set", () => {
    const ast = {
      models: [
        {
          tableName: "widget",
          fields: {
            id: { kind: "uuid", pgType: "UUID", required: true, primaryKey: true, default: { kind: "genRandomUuid" } },
            name: { kind: "text", pgType: "TEXT", required: true },
            created_at: { kind: "text", pgType: "TEXT", required: true, serverGenerated: true },
          },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    const insertOnly = out.split("Update:")[0] ?? out
    expect(insertOnly).toContain("id?:")
    expect(insertOnly).toContain("created_at?:")
    expect(insertOnly).toContain("name: string")
    expect(insertOnly).not.toContain("name?:")
  })

  it("types richText fields as SerializedEditorState", () => {
    const ast = {
      models: [
        {
          tableName: "note",
          fields: {
            id: { kind: "uuid", pgType: "UUID", required: true, primaryKey: true, default: { kind: "genRandomUuid" } },
            body: { kind: "richText", pgType: "JSONB", required: true },
          },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    expect(out).toContain('import("@supatype/types/lexical").SerializedEditorState')
    expect(out).not.toMatch(/body: Record<string, unknown>/)
  })
})
