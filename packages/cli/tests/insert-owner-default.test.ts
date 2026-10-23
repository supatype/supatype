import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

// The engine defaults an auth user id that the create rule says must be the caller's to
// `_supatype.jwt_uid()` (its normaliser's `default_owner_to_caller`), so its own types make that
// column optional on insert. The CLI's augmentation has to say the same, or every insert is asked
// for a value the database already knows.

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function augmentationFor(access: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-owner-default-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  const source = [
    'import type { Model, Owner, Any, Public, SupatypeAuthUserId } from "@supatype/types"',
    "",
    "export type Comment = Model<{",
    "  user_id: SupatypeAuthUserId<{ onDelete: \"cascade\" }>",
    "  body: string",
    `}, { access: { read: Public${access} } }>`,
    "",
  ].join("\n")
  writeFileSync(schemaPath, source, "utf8")
  return generateClientAugmentation(extractSchemaAstFromTypes(schemaPath, dir))
}

function insertBlock(augmentation: string): string {
  const match = /Insert: \{([^}]*)\}/.exec(augmentation)
  if (match?.[1] === undefined) throw new Error("no Insert type")
  return match[1]
}

describe("Insert type of an owner auth user id", () => {
  it("is optional when the create rule names it, as the column defaults to the caller", () => {
    const insert = insertBlock(augmentationFor(', create: Owner<"user_id">'))
    expect(insert).toContain("user_id?: string")
    expect(insert).toMatch(/\bbody: string/)
  })

  it("is optional when the owner sits inside an any rule", () => {
    const insert = insertBlock(augmentationFor(', create: Any<[Owner<"user_id">, Public]>'))
    expect(insert).toContain("user_id?: string")
  })

  it("stays required when no create rule names it, since the engine adds no default", () => {
    const insert = insertBlock(augmentationFor(""))
    expect(insert).toMatch(/\buser_id: string/)
  })
})
