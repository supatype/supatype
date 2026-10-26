import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { validateProjectConfig } from "../src/project-config.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/**
 * Q1 and Q3: a schema name is written unquoted in places (the masking labels, `PGRST_DB_SCHEMA`),
 * and a `$` can end a dollar-quoted function body. So a name that is not a plain identifier,
 * `^[a-z_][a-z0-9_]*$` and at most 63 bytes, is refused when the config is read, before anything
 * is generated from it. The engine refuses the same names at its own boundary.
 */
const validate = (schema: unknown) =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
      schema,
    },
    "supatype.config.ts",
  )

describe("schema names in the config", () => {
  it("accepts plain identifiers, and no schema section", () => {
    expect(() => validate(undefined)).not.toThrow()
    expect(() => validate({ pg_schema: "app" })).not.toThrow()
    expect(() => validate({ pg_schema: "_tenant_42", api_schemas: ["_tenant_42", "auth"] })).not.toThrow()
  })

  it("refuses a pg_schema with a dollar, a capital, a hyphen or a leading digit", () => {
    for (const name of ["a$b", "App", "my-app", "1app", "x\"y", "a".repeat(64)]) {
      expect(() => validate({ pg_schema: name }), name).toThrow(/schema\.pg_schema/)
    }
  })

  it("names the rule and the value it refused", () => {
    expect(() => validate({ pg_schema: "a$b" })).toThrow(/"a\$b".*\^\[a-z_\]\[a-z0-9_\]\*\$/)
  })

  it("refuses an api_schemas entry that is not plain", () => {
    expect(() => validate({ api_schemas: ["app", "Bad-Name"] })).toThrow(/schema\.api_schemas/)
  })
})

/**
 * O1: the engine treats a model keyed by an auth user id as the user's own, and refuses an owner
 * relation to a model that is neither that nor owned. It cannot tell such an id from any other
 * UUID, so the CLI marks it.
 */
describe("SupatypeAuthUserId in the AST", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("is marked authUserId, and a plain UUID is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-auth-user-id-"))
    dirs.push(dir)
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `import type { Model, Optional, SupatypeAuthUserId, UUID } from "@supatype/types"\n\n` +
        `export type Profile = Model<{\n  id: SupatypeAuthUserId\n  invitedBy: Optional<SupatypeAuthUserId>\n  externalId: UUID\n}>\n`,
      "utf8",
    )
    const profile = extractSchemaAstFromTypes(schemaPath, dir)?.models.find((m) => m.name === "Profile")
    expect(profile?.fields["id"]?.annotations?.db).toMatchObject({ pgType: "UUID", authUserId: true })
    expect(profile?.fields["invitedBy"]?.annotations?.db).toMatchObject({ authUserId: true })
    expect(profile?.fields["externalId"]?.annotations?.db).not.toHaveProperty("authUserId")
  })
})
