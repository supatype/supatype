import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"
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

const versionedAst = {
  version: 2,
  models: [{ name: "Post", tableName: "post", options: { versions: { drafts: true } }, fields: [] }],
} as unknown as ExtractedSchemaAstV2

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
    const document = { operations: [] } as never
    const ran = apply([{ file: "seed.ts", document, config: {} }], {
      cwd: process.cwd(),
      config,
      dsn: "postgresql://u:p@127.0.0.1:5432/app",
      opts: { force: false, atomic: false, status: false },
      engine: undefined,
    })
    expect(await ran).toBe(0)
    const ast = sent.body?.["ast"] as Record<string, unknown> | undefined
    expect(ast?.["publishing"]).toMatchObject({ draftVisibility: expect.anything() })
  })
})
