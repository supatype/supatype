import { describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"

describe("generateClientAugmentation", () => {
  it("emits deterministic output independent of model order", () => {
    const astA = {
      models: [
        { tableName: "post", fields: { title: { kind: "text", required: true } } },
        { tableName: "comment", fields: { body: { kind: "text", required: true } } },
      ],
    }
    const astB = {
      models: [
        { tableName: "comment", fields: { body: { kind: "text", required: true } } },
        { tableName: "post", fields: { title: { kind: "text", required: true } } },
      ],
    }

    expect(generateClientAugmentation(astA)).toEqual(generateClientAugmentation(astB))
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
