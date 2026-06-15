import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  buildAliasRegistry,
  createResolveContext,
  needsChecker,
  tryResolveTypeReference,
} from "../src/type-resolver.js"

describe("type-resolver", () => {
  it("detects conditional and mapped alias bodies", () => {
    const conditionalSf = ts.createSourceFile(
      "conditional.ts",
      "type NullableStr<T> = T extends string ? Optional<T> : T",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const mappedSf = ts.createSourceFile(
      "mapped.ts",
      "type AllOptional<T> = { [K in keyof T]: Optional<T[K]> }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const conditional = buildAliasRegistry([conditionalSf]).get("NullableStr")
    const mapped = buildAliasRegistry([mappedSf]).get("AllOptional")
    expect(needsChecker(conditional!.body)).toBe(true)
    expect(needsChecker(mapped!.body)).toBe(true)
  })

  it("resolves conditional aliases through the checker", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-resolver-conditional-"))
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `
type NullableStr<T> = T extends string ? Optional<T> : T
type FieldEmail = string
type Use = NullableStr<FieldEmail>
`,
      "utf8",
    )
    const sourceText = readFileSync(schemaPath, "utf8")
    const sourceFile = ts.createSourceFile(schemaPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const ctx = createResolveContext([sourceFile])
    const useDecl = sourceFile.statements.find(
      (stmt): stmt is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "Use",
    )
    expect(useDecl).toBeDefined()
    const fieldType = useDecl!.type as ts.TypeReferenceNode
    const resolved = tryResolveTypeReference(fieldType, sourceFile, ctx, { fieldName: "email" })
    expect(resolved).not.toBeNull()
    expect(resolved!.getText()).toContain("Optional")
  })
})
