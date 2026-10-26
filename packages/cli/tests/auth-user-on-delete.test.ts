import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { astRelatesToAuthUsers, findByoGaps } from "../src/byo-preflight.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/**
 * `SupatypeAuthUserId<{ onDelete }>` opts one field in to a foreign key to `auth.users`. The CLI
 * reads the option into `annotations.db.authUserOnDelete`, which the engine turns into the key, and a
 * push to a database without `auth.users` is told so before the engine runs.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(fields: string) {
  const dir = mkdtempSync(join(tmpdir(), "supatype-auth-on-delete-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `import type { Model, Optional, SupatypeAuthUserId, UUID } from "@supatype/types"\n\n` +
      `export type Comment = Model<{\n  id: UUID\n${fields}\n}>\n`,
    "utf8",
  )
  const ast = extractSchemaAstFromTypes(schemaPath, dir)
  return { ast, comment: ast?.models.find((m) => m.name === "Comment") }
}

describe("SupatypeAuthUserId<{ onDelete }> in the AST", () => {
  it("carries the delete behaviour beside the authUserId mark", () => {
    const { comment } = extract(
      `  user_id: SupatypeAuthUserId<{ onDelete: "cascade" }>\n` +
        `  approver_id: SupatypeAuthUserId<{ onDelete: "restrict" }>\n` +
        `  editor_id: Optional<SupatypeAuthUserId<{ onDelete: "setNull" }>>\n` +
        `  viewer_id: SupatypeAuthUserId`,
    )
    expect(comment?.fields["user_id"]?.annotations?.db).toMatchObject({
      pgType: "UUID",
      authUserId: true,
      authUserOnDelete: "cascade",
    })
    expect(comment?.fields["approver_id"]?.annotations?.db).toMatchObject({ authUserOnDelete: "restrict" })
    expect(comment?.fields["editor_id"]?.annotations?.db).toMatchObject({ authUserOnDelete: "setNull" })
    expect(comment?.fields["editor_id"]?.required).toBe(false)
    expect(comment?.fields["viewer_id"]?.annotations?.db).toMatchObject({ authUserId: true })
    expect(comment?.fields["viewer_id"]?.annotations?.db).not.toHaveProperty("authUserOnDelete")
  })

  it("refuses a behaviour it does not know, naming the field and the ones it does", () => {
    expect(() => extract(`  user_id: SupatypeAuthUserId<{ onDelete: "noAction" }>`)).toThrow(
      /user_id.*"cascade", "restrict" or "setNull"/,
    )
  })

  it("refuses any option but onDelete", () => {
    expect(() => extract(`  user_id: SupatypeAuthUserId<{ generated: "gen_random_uuid()" }>`)).toThrow(
      /user_id.*takes onDelete, not generated/,
    )
  })
})

describe("a push that links rows to auth.users", () => {
  const linked = {
    models: [{ name: "Comment", fields: { user_id: { kind: "uuid", annotations: { db: { authUserId: true, authUserOnDelete: "cascade" } } } } }],
  }
  const unlinked = {
    models: [{ name: "Comment", fields: { user_id: { kind: "uuid", annotations: { db: { authUserId: true } } } } }],
  }

  it("needs auth.users when a field asks for the key, and not for a plain auth user id", async () => {
    expect(astRelatesToAuthUsers(linked)).toBe(true)
    expect(astRelatesToAuthUsers(unlinked)).toBe(false)
    const noAuthUsers = async (sql: string): Promise<Array<Record<string, unknown>>> =>
      sql.includes("pg_roles") ? [] : [{ present: false }]
    expect((await findByoGaps(noAuthUsers, linked)).missingAuthUsers).toBe(true)
    expect((await findByoGaps(noAuthUsers, unlinked)).missingAuthUsers).toBe(false)
  })
})
