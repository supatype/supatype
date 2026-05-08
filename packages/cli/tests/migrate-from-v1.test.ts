import ts from "typescript"
import { describe, expect, it } from "vitest"
import { codemodSource } from "../src/commands/migrate-from-v1.js"

describe("migrate-from-v1 codemod", () => {
  it("converts exported model() declarations into Model<> aliases", () => {
    const source = ts.createSourceFile(
      "schema.ts",
      `
import { model, field } from "@supatype/schema"
export const User = model("user", {
  fields: {
    id: field.uuid({ required: true }),
    email: field.email({ required: true, unique: true }),
    name: field.text({ required: true }),
  },
})
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )

    const out = codemodSource(source)
    expect(out).toContain("export type User = Model<")
    expect(out).toContain("id: UUID")
    expect(out).toContain("email: string")
  })
})
