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

// A profile keyed by its user (`id: SupatypeAuthUserId`) is a primary key, but under
// `create: Owner<"id">` not one the database may invent: a random uuid names no user, and with no
// default of its own the engine defaults it to the caller, so an insert can leave `id` out. Under
// any other create rule nothing defaults it to the caller, so it keeps the random default every
// uuid key gets, and a NOT NULL key is never left with no default at all.
function profileSchema(access: string, imports = "Model, Owner, Public, SupatypeAuthUserId"): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-owner-default-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  const source = [
    `import type { ${imports} } from "@supatype/types"`,
    "",
    "export type Profile = Model<{",
    "  id: SupatypeAuthUserId",
    "  name: string",
    `}, { access: { read: Public${access} } }>`,
    "",
  ].join("\n")
  writeFileSync(schemaPath, source, "utf8")
  return schemaPath
}

function profileId(schemaPath: string): Record<string, unknown> | undefined {
  return extractSchemaAstFromTypes(schemaPath, join(schemaPath, ".."))?.models[0]?.fields["id"]
}

function profileInsert(schemaPath: string): string {
  return insertBlock(generateClientAugmentation(extractSchemaAstFromTypes(schemaPath, join(schemaPath, ".."))))
}

describe("an auth user id primary key", () => {
  it("gets no random uuid default when the create rule is Owner<\"id\">", () => {
    const id = profileId(profileSchema(', create: Owner<"id">'))
    expect(id).toMatchObject({ primaryKey: true, required: true })
    expect(id?.["default"]).toBeUndefined()
  })

  it("gets no random uuid default when the owner sits inside an all rule", () => {
    const id = profileId(profileSchema(', create: All<[Owner<"id">, LoggedIn]>', "Model, Owner, All, LoggedIn, Public, SupatypeAuthUserId"))
    expect(id?.["default"]).toBeUndefined()
  })

  it("keeps the random uuid default under a create rule that does not name it", () => {
    const id = profileId(profileSchema(", create: LoggedIn", "Model, LoggedIn, Public, SupatypeAuthUserId"))
    expect(id?.["default"]).toEqual({ kind: "genRandomUuid" })
  })

  it("keeps the random uuid default with no create rule", () => {
    expect(profileId(profileSchema(""))?.["default"]).toEqual({ kind: "genRandomUuid" })
  })

  it("is optional on insert when the create rule is Owner<\"id\">", () => {
    expect(profileInsert(profileSchema(', create: Owner<"id">'))).toContain("id?: string")
  })

  it("is optional on insert under another create rule, as the random default fills it", () => {
    const insert = profileInsert(profileSchema(", create: LoggedIn", "Model, LoggedIn, Public, SupatypeAuthUserId"))
    expect(insert).toContain("id?: string")
  })
})
