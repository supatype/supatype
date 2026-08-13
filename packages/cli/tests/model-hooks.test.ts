import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { declaredHooks, validateModelHooks } from "../src/model-hooks.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(schema: string): { dir: string; ast: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "supatype-hooks-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(schemaPath, schema, "utf8")
  return { dir, ast: extractSchemaAstFromTypes(schemaPath, dir) }
}

/** A function the worker would discover: a directory with an index.ts. */
function addFunction(dir: string, name: string): void {
  mkdirSync(join(dir, "functions", name), { recursive: true })
  writeFileSync(join(dir, "functions", name, "index.ts"), "export default () => new Response()", "utf8")
}

describe("model hooks — declaration", () => {
  it("extracts both the shorthand and the options form", () => {
    const { ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID; title: string }, {
  tableName: "posts"
  hooks: {
    beforeChange: "moderate-post"
    afterChange: { function: "index-post"; timeout: 5000; onUnavailable: "log" }
  }
}>
`)
    expect(declaredHooks(ast)).toEqual([
      { model: "Post", event: "afterChange", function: "index-post" },
      { model: "Post", event: "beforeChange", function: "moderate-post" },
    ])

    const models = (ast as { models: { annotations: { platform: { hooks?: Record<string, unknown> } } }[] }).models
    expect(models[0]?.annotations.platform.hooks).toEqual({
      beforeChange: { function: "moderate-post" },
      afterChange: { function: "index-post", timeout: 5000, onUnavailable: "log" },
    })
  })

  it("carries no hooks annotation when a model declares none", () => {
    const { ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`)
    const models = (ast as { models: { annotations: { platform: Record<string, unknown> } }[] }).models
    expect(models[0]?.annotations.platform["hooks"]).toBeUndefined()
    expect(declaredHooks(ast)).toEqual([])
  })

  it("ignores an event name that is not a lifecycle hook", () => {
    // `beforeRead` was dropped from the design. Extracting it would put a hook in the manifest that
    // the server has no point at which to call, which reads as "declared and silently ignored".
    const { ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, {
  tableName: "posts"
  hooks: { beforeRead: "nope"; beforeChange: "yes" }
}>
`)
    expect(declaredHooks(ast).map((h) => h.event)).toEqual(["beforeChange"])
  })
})

describe("model hooks — push-time validation", () => {
  const schema = `
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, {
  tableName: "posts"
  hooks: { beforeChange: "moderate-post" }
}>
`

  it("passes when the named function exists", () => {
    const { dir, ast } = project(schema)
    addFunction(dir, "moderate-post")
    expect(validateModelHooks(ast, join(dir, "functions"), dir)).toEqual([])
  })

  it("reports the hook, the path searched, and what is available", () => {
    // The failure this prevents: a typo'd name extracts cleanly, reaches the manifest, never fires,
    // and the write it was meant to validate succeeds looking perfectly normal.
    const { dir, ast } = project(schema)
    addFunction(dir, "moderate-posts") // note the plural
    const problems = validateModelHooks(ast, join(dir, "functions"), dir)

    expect(problems.join("\n")).toContain("Post.beforeChange")
    expect(problems.join("\n")).toContain('"moderate-post"')
    expect(problems.join("\n")).toContain("moderate-posts")
  })

  it("says how to create one when the functions directory is empty", () => {
    const { dir, ast } = project(schema)
    mkdirSync(join(dir, "functions"), { recursive: true })
    expect(validateModelHooks(ast, join(dir, "functions"), dir).join("\n")).toContain(
      "supatype functions new",
    )
  })

  it("does not require a functions directory when no hooks are declared", () => {
    const { dir, ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`)
    expect(validateModelHooks(ast, join(dir, "functions"), dir)).toEqual([])
  })

  it("ignores a file and an underscore directory when listing functions", () => {
    // Matches how the worker discovers handlers: `_shared` is shared code, not a function.
    const { dir, ast } = project(schema)
    mkdirSync(join(dir, "functions", "_shared"), { recursive: true })
    writeFileSync(join(dir, "functions", "_shared", "index.ts"), "export const x = 1", "utf8")
    writeFileSync(join(dir, "functions", "readme.md"), "notes", "utf8")

    const problems = validateModelHooks(ast, join(dir, "functions"), dir).join("\n")
    expect(problems).toContain("No functions found")
    expect(problems).not.toContain("_shared")
  })
})
