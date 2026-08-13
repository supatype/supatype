import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  declaredHooks,
  manifestHooks,
  syncManifestHooks,
  validateModelHooks,
  writeHooksModule,
} from "../src/model-hooks.js"
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

describe("model hooks — manifest map", () => {
  const schema = `
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, {
  tableName: "posts"
  hooks: { beforeChange: "moderate-post"; afterChange: { function: "index-post"; timeout: 9000 } }
}>
`

  it("keys by table name and fills the safe default per phase", () => {
    const { ast } = project(schema)
    // Keyed by table, not model: the server matches a request path.
    expect(manifestHooks(ast)).toEqual({
      posts: {
        beforeChange: {
          function: "moderate-post",
          timeout: DEFAULT_HOOK_TIMEOUT_MS,
          // Unreachable before a write must not let the write through...
          onUnavailable: "reject",
        },
        afterChange: {
          function: "index-post",
          timeout: 9000,
          // ...but after one there is nothing left to fail.
          onUnavailable: "log",
        },
      },
    })
  })

  it("merges into an existing manifest and leaves its other keys alone", () => {
    const { dir, ast } = project(schema)
    mkdirSync(join(dir, ".supatype"), { recursive: true })
    writeFileSync(
      join(dir, ".supatype", "manifest.json"),
      JSON.stringify({ schema: "tenant_7", functions_enabled: true }),
      "utf8",
    )

    expect(syncManifestHooks(dir, ast)).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(dir, ".supatype", "manifest.json"), "utf8"),
    ) as Record<string, unknown>
    expect(manifest["schema"]).toBe("tenant_7")
    expect(manifest["functions_enabled"]).toBe(true)
    expect(Object.keys(manifest["hooks"] as object)).toEqual(["posts"])
  })

  it("never creates a manifest from scratch", () => {
    // `functions_enabled` is a plain bool on the server's side, so a manifest carrying only hooks
    // would read as functions *disabled* — the defect fixed one commit earlier, by another door.
    const { dir, ast } = project(schema)
    expect(syncManifestHooks(dir, ast)).toBe(false)
    expect(existsSync(join(dir, ".supatype", "manifest.json"))).toBe(false)
  })

  it("removes the hook map when the last hook goes away", () => {
    const { dir, ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`)
    mkdirSync(join(dir, ".supatype"), { recursive: true })
    writeFileSync(
      join(dir, ".supatype", "manifest.json"),
      JSON.stringify({ functions_enabled: true, hooks: { posts: { beforeChange: { function: "gone" } } } }),
      "utf8",
    )

    expect(syncManifestHooks(dir, ast)).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(dir, ".supatype", "manifest.json"), "utf8"),
    ) as Record<string, unknown>
    expect(manifest["hooks"]).toBeUndefined()
  })
})

describe("model hooks — generated module on disk", () => {
  it("removes a stale module when the last hook is deleted", () => {
    // Otherwise a typed module sits there claiming tables are hooked, and a handler importing it
    // keeps compiling while never running.
    const { dir, ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts" }>
`)
    const functionsDir = join(dir, "functions")
    mkdirSync(join(functionsDir, "_supatype"), { recursive: true })
    writeFileSync(join(functionsDir, "_supatype", "hooks.ts"), "export type Stale = true", "utf8")

    expect(writeHooksModule(dir, functionsDir, ast)).toBeNull()
    expect(existsSync(join(functionsDir, "_supatype", "hooks.ts"))).toBe(false)
  })

  it("writes the module beside the functions that import it", () => {
    const { dir, ast } = project(`
import type { Model, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID }, { tableName: "posts"; hooks: { beforeChange: "x" } }>
`)
    const functionsDir = join(dir, "functions")
    const written = writeHooksModule(dir, functionsDir, ast)
    expect(written).toContain(join("functions", "_supatype", "hooks.ts"))
    expect(readFileSync(join(functionsDir, "_supatype", "hooks.ts"), "utf8")).toContain("HookedTable")
  })
})
