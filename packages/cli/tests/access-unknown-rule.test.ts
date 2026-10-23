import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { errorMessage } from "../src/error-message.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/**
 * The unknown-rule error lists the rules the parser accepts. It was written by hand and left out
 * `Matches`, `In` and `Exists`, so an author who mistyped one was told it did not exist. The list is
 * now generated from the table the parser dispatches on, so every rule it accepts is named.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function unknownRuleError(): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-unknown-rule-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  const source = [
    `import type { Model, UUID } from "@supatype/types"`,
    `export type Post = Model<{ id: UUID }, { access: { read: Mystery } }>`,
    ``,
  ].join("\n")
  writeFileSync(schemaPath, source, "utf8")
  try {
    extractSchemaAstFromTypes(schemaPath, dir)
  } catch (err: unknown) {
    return errorMessage(err)
  }
  throw new Error("an unknown rule was accepted")
}

const EVERY_RULE = [
  "Public", "Private", "LoggedIn", "Owner", "OwnerFrom", "Role", "Any", "All", "Not",
  "Eq", "Neq", "Gt", "Gte", "Lt", "Lte", "Like", "Matches", "IsNull", "NotNull", "Exists", "In",
  "BucketPublic", "BucketPrivate", "BucketLoggedIn", "BucketOwner", "BucketRole",
]

describe("the unknown access rule error", () => {
  it("names the unknown rule", () => {
    expect(unknownRuleError()).toContain('Unknown access rule "Mystery"')
  })

  it.each(EVERY_RULE)("lists %s among the supported rules", (rule) => {
    const supported = unknownRuleError().split("Supported:")[1] ?? ""
    expect(supported.split(/[^A-Za-z]+/)).toContain(rule)
  })
})
