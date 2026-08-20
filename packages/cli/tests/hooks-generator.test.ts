import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { generateHooksModule } from "../src/hooks-generator.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function astFor(schema: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "supatype-hooksgen-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(schemaPath, schema, "utf8")
  return extractSchemaAstFromTypes(schemaPath, dir)
}

const HOOKED_SCHEMA = `
import type { Model, Optional, RichText, Timestamp, UUID } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
  body: RichText
  views: Optional<number>
  created_at: Timestamp
}, {
  tableName: "posts"
  hooks: { beforeChange: "moderate-post"; afterDelete: "purge-post" }
}>

export type Comment = Model<{ id: UUID; body: string }, { tableName: "comments" }>
`

describe("generateHooksModule", () => {
  it("returns null when nothing declares a hook", () => {
    const ast = astFor(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`)
    // A generated file nobody imports is a file somebody eventually edits.
    expect(generateHooksModule(ast)).toBeNull()
  })

  it("includes only the tables that declare a hook", () => {
    const module = generateHooksModule(astFor(HOOKED_SCHEMA))
    expect(module).not.toBeNull()
    expect(module).toContain('"posts": {')
    // `HookedTable` is what makes `BeforeChange<"comments">` a compile error, so an unhooked table
    // must not appear at all.
    expect(module).not.toContain('"comments": {')
  })

  it("carries the model's real columns into Row, Insert and Update", () => {
    const module = generateHooksModule(astFor(HOOKED_SCHEMA)) ?? ""
    expect(module).toContain("title: string")
    // `created_at` is server-generated, so it is optional on insert but present on a row.
    expect(module).toMatch(/Insert: \{[\s\S]*created_at\?:/)
    expect(module).toMatch(/Row: \{[\s\S]*created_at: string/)
    // Every column is optional on a patch.
    expect(module).toMatch(/Update: \{[\s\S]*title\?: string/)
  })
})

describe("the generated module compiles", () => {
  /**
   * The generator emits TypeScript, so the only test that really proves it works is a compiler.
   * A missing brace or a type that does not resolve would otherwise reach a user's editor, and this
   * file is imported by their hook, so a broken emit breaks their function rather than our build.
   */
  it("typechecks under strict mode, together with a handler that uses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-hookscompile-"))
    dirs.push(dir)

    const module = generateHooksModule(astFor(HOOKED_SCHEMA))
    expect(module).not.toBeNull()
    writeFileSync(join(dir, "hooks.ts"), module ?? "", "utf8")

    // `supatype functions new` writes a `functions/deno.d.ts`, which is where a real project gets
    // this. The generated module uses `Deno.env` to find the API, so the fixture needs it too.
    writeFileSync(
      join(dir, "deno.d.ts"),
      `declare namespace Deno {
  const env: { get(key: string): string | undefined }
}
`,
      "utf8",
    )

    // A handler written the way the docs will show it, including the narrowing that the
    // discriminated union is there to provide.
    writeFileSync(
      join(dir, "handler.ts"),
      `import { hook, type AfterDelete, type BeforeChange } from "./hooks.ts"

const moderate: BeforeChange<"posts"> = async (ctx) => {
  if (ctx.operation === "insert") {
    if (ctx.rows.some((r) => r.title.trim() === "")) return { reject: "A post needs a title" }
    return { rows: ctx.rows.map((r) => ({ ...r, title: r.title.trim() })) }
  }
  const { rows, truncated } = await ctx.previous()
  if (truncated) return { reject: { message: "Too many rows", status: 409 } }
  if (rows.length === 0) return {}
  return { patch: { ...ctx.patch, title: ctx.patch.title ?? rows[0]!.title } }
}

const purge: AfterDelete<"posts"> = async (ctx) => {
  void ctx.filter
}

export default hook(moderate)
export const alsoPurge = hook(purge)
`,
      "utf8",
    )

    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          target: "ES2022",
          module: "Preserve",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          lib: ["ES2022", "DOM"],
          types: [],
        },
        include: ["*.ts"],
      }),
      "utf8",
    )

    const tsc = join(__dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc")
    let output = ""
    try {
      execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string }
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    }
    expect(output).toBe("")
  })

  it("rejects a handler for a table that declares no hook", () => {
    // The point of `HookedTable`: naming an unhooked table must not silently produce a handler that
    // never runs.
    const dir = mkdtempSync(join(tmpdir(), "supatype-hooksneg-"))
    dirs.push(dir)
    writeFileSync(join(dir, "hooks.ts"), generateHooksModule(astFor(HOOKED_SCHEMA)) ?? "", "utf8")
    // `supatype functions new` writes a `functions/deno.d.ts`, which is where a real project gets
    // this. The generated module uses `Deno.env` to find the API, so the fixture needs it too.
    writeFileSync(
      join(dir, "deno.d.ts"),
      `declare namespace Deno {
  const env: { get(key: string): string | undefined }
}
`,
      "utf8",
    )

    writeFileSync(
      join(dir, "handler.ts"),
      `import type { BeforeChange } from "./hooks.ts"
const nope: BeforeChange<"comments"> = async () => ({})
export default nope
`,
      "utf8",
    )
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "Preserve",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          lib: ["ES2022", "DOM"],
          types: [],
        },
        include: ["*.ts"],
      }),
      "utf8",
    )

    const tsc = join(__dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc")
    let output = ""
    try {
      execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string }
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    }
    expect(output).toContain("comments")
  })
})
