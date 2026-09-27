/**
 * The generated files that need no engine, and which `dev` never wrote.
 *
 * `push` and `generate` go through `writeGeneratedTypes`. `dev` has its own type generation, which
 * it should keep: it slices the engine's output from a marker and treats a failure as a warning
 * rather than killing the session. What it should not have had is its own idea of which files
 * exist, and the result was that a project developed entirely through `supatype dev` never
 * received the module augmentation that types `createClient` without a generic.
 *
 * Both files come from the AST alone, so they are shared and all three commands write them.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeAstDerivedOutputs } from "../src/type-generation.js"

const ast = {
  models: [
    {
      name: "JobPost",
      annotations: { db: { tableName: "job_post" } },
      fields: {
        id: { kind: "uuid", required: true },
        views: { kind: "bigInt", required: true },
      },
    },
  ],
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-outputs-"))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe("writeAstDerivedOutputs", () => {
  it("writes the augmentation and the project client together", () => {
    const written = writeAstDerivedOutputs({
      cwd,
      ast,
      typesPath: "supatype/generated/database.ts",
      clientPath: "supatype/generated/index.d.ts",
    })

    expect(existsSync(join(cwd, "supatype/generated/index.d.ts"))).toBe(true)
    expect(existsSync(join(cwd, "supatype/generated/client.ts"))).toBe(true)
    expect(written).toHaveLength(2)
  })

  it("puts the client beside the generated types", () => {
    // An app imports it by a relative path, so it has to land next to the rest of the generated
    // output rather than at the project root.
    writeAstDerivedOutputs({ cwd, ast, clientPath: "supatype/generated/index.d.ts" })
    const body = readFileSync(join(cwd, "supatype/generated/client.ts"), "utf8")

    expect(body).toContain('export * from "@supatype/client"')
    expect(body).toContain('declare module "@supatype/client"')
    expect(body).toContain('"views": "bigint"')
  })

  it("writes nothing when a project configured no output at all", () => {
    // `push` must not start creating files in projects that never asked for any.
    expect(writeAstDerivedOutputs({ cwd, ast })).toEqual([])
    expect(existsSync(join(cwd, "supatype"))).toBe(false)
  })

  it("needs no engine, so it can run when type generation could not", () => {
    // This is why it is separate: in `dev` the engine may be unavailable, and the augmentation and
    // the client should still reach the project.
    const written = writeAstDerivedOutputs({ cwd, ast, clientPath: "supatype/generated/index.d.ts" })
    expect(written.some((line) => line.includes("Client written"))).toBe(true)
  })
})

describe("a project that configured only types", () => {
  it("still gets a client, beside the types", () => {
    // Otherwise it has generated types and no way to use them that knows its schema: the
    // augmentation and the exact-value columns both travel in this file.
    const dir = mkdtempSync(join(tmpdir(), "supatype-types-only-"))
    try {
      writeAstDerivedOutputs({ cwd: dir, ast, typesPath: "supatype/generated/database.ts" })
      expect(existsSync(join(dir, "supatype/generated/client.ts"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
