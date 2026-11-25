import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"
import type { SeedIr } from "../src/seed.js"
import { isJsonObject } from "@supatype/shared"
import type { ExtractedSchemaAstV2 } from "../src/schema-ast-v2.js"

/**
 * FF-1: a seed against a schema with a versioned model failed, because the engine was sent the bare
 * AST where push sends it with the `publishing` settings that model needs. Seed now sends the same.
 */

const sent = vi.hoisted(() => ({ body: undefined as Record<string, unknown> | undefined }))

vi.mock("../src/stack-engine.js", () => ({
  stackEngine: async () => undefined,
  engineRequestIn: async (_engine: unknown, _path: string, body: Record<string, unknown>) => {
    sent.body = body
    return { ok: true, files: [] }
  },
}))

const versionedAst: ExtractedSchemaAstV2 = {
  astVersion: 2,
  models: [
    {
      name: "Post",
      fields: {},
      options: { versions: { drafts: true } },
      annotations: { db: { tableName: "post", indexes: [] }, platform: { access: {} } },
    },
  ],
}

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadSchemaAst: () => versionedAst,
}))

const { apply } = await import("../src/commands/seed.js")

afterEach(() => {
  sent.body = undefined
  vi.restoreAllMocks()
})

describe("supatype seed with a versioned model", () => {
  it("sends the engine the schema with its publishing settings, as push does", async () => {
    
    const config = projectConfig({ provider: "docker" })
    const document: SeedIr = { irVersion: 1, schemaFingerprint: "fp-1", operations: [] }
    const ran = apply([{ file: "seed.ts", document, config: {} }], {
      cwd: process.cwd(),
      config,
      dsn: "postgresql://u:p@127.0.0.1:5432/app",
      opts: { force: false, atomic: false, status: false },
      engine: undefined,
    })
    expect(await ran).toBe(0)
    const ast = sent.body?.["ast"]
    const publishing = isJsonObject(ast) ? ast["publishing"] : undefined
    expect(isJsonObject(publishing) && publishing["draftVisibility"] !== undefined && publishing["draftVisibility"] !== null).toBe(true)
  })
})
