import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { generateHooksModule } from "../src/hooks-generator.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/** What `tsc -p <dir>/tsconfig.json` printed: nothing when the project compiles. */
function tscOutput(dir: string): string {
  const tsc = join(__dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc")
  try {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return ""
  } catch (err) {
    // A failed execFileSync carries the child's output on the error.
    if (!(err instanceof Error)) throw err
    const stdout = "stdout" in err && typeof err.stdout === "string" ? err.stdout : ""
    const stderr = "stderr" in err && typeof err.stderr === "string" ? err.stderr : ""
    return `${stdout}${stderr}`
  }
}

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

/**
 * What tsc prints for the generated `module` beside `handler`, in a project set up the way a hook's
 * is: a `deno.d.ts` for `Deno.env` (which `supatype functions new` writes) and strict options.
 */
function compileWithHandler(
  module: string | null,
  handler: string,
  options: { exactOptionalPropertyTypes?: boolean } = {},
): string {
  expect(module).not.toBeNull()
  const dir = mkdtempSync(join(tmpdir(), "supatype-hookscompile-"))
  dirs.push(dir)
  writeFileSync(join(dir, "hooks.ts"), module ?? "", "utf8")
  writeFileSync(join(dir, "deno.d.ts"), DENO_ENV, "utf8")
  writeFileSync(join(dir, "handler.ts"), handler, "utf8")
  const compilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: options.exactOptionalPropertyTypes ?? true,
    noEmit: true,
    target: "ES2022",
    module: "Preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    lib: ["ES2022", "DOM"],
    types: [],
  }
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["*.ts"] }), "utf8")
  return tscOutput(dir)
}

const DENO_ENV = `declare namespace Deno {
  const env: { get(key: string): string | undefined }
}
`

const HOOKED_SCHEMA = `
import type { Block, Blocks, Button, Model, Optional, RichText, Timestamp, UUID } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
  body: RichText
  views: Optional<number>
  cta: Optional<Button>
  links: Optional<Blocks<Block<"link", { label: string; href: string }>>>
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

  // 0.9.1 release test (FF3): a hook's row is the row the database holds, and that includes the
  // columns `timestamps: true` adds, which the client's types also left out.
  it("carries the columns a model's options add into the hook's row", () => {
    const module = generateHooksModule(astFor(`
import type { Model, UUID } from "@supatype/types"

export type Note = Model<{ id: UUID; body: string }, {
  tableName: "notes"
  timestamps: true
  hooks: { beforeChange: "check-note" }
}>
`)) ?? ""
    const row = module.slice(module.indexOf("Row: {"), module.indexOf("Insert: {"))
    expect(row).toContain("updated_at: string")
    expect(module).toMatch(/Insert: \{[^}]*updated_at\?: string/)
  })
})

describe("the generated module compiles", () => {
  /**
   * The generator emits TypeScript, so the only test that really proves it works is a compiler.
   * A missing brace or a type that does not resolve would otherwise reach a user's editor, and this
   * file is imported by their hook, so a broken emit breaks their function rather than our build.
   */
  it("typechecks under strict mode, together with a handler that uses it", () => {
    // A handler written the way the docs will show it, including the narrowing that the
    // discriminated union is there to provide.
    const output = compileWithHandler(
      generateHooksModule(astFor(HOOKED_SCHEMA)),
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
  for (const row of ctx.old) void row.title
  void ctx.deliveryId
}

export default hook(moderate)
export const alsoPurge = hook(purge)
`,
    )
    expect(output).toBe("")
  })

  it("rejects a handler for a table that declares no hook", () => {
    // The point of `HookedTable`: naming an unhooked table must not silently produce a handler that
    // never runs.
    const output = compileWithHandler(
      generateHooksModule(astFor(HOOKED_SCHEMA)),
      `import type { BeforeChange } from "./hooks.ts"
const nope: BeforeChange<"comments"> = async () => ({})
export default nope
`,
      { exactOptionalPropertyTypes: false },
    )
    expect(output).toContain("comments")
  })
})

describe("after-hook rows", () => {
  const RESTRICTED_SCHEMA = `
import type { LoggedIn, Model, Public, Role, UUID } from "@supatype/types"

export type Post = Model<{ id: UUID; title: string; secretNote: string }, {
  tableName: "posts"
  access: { read: Public; create: LoggedIn; fields: { secretNote: { read: Role<"admin"> } } }
  hooks: { afterChange: "notify"; afterDelete: { function: "audit"; columns: "all" } }
}>
`

  it("gives afterChange its rows always, the old rows on update, and a delivery id", () => {
    const output = compileWithHandler(
      generateHooksModule(astFor(RESTRICTED_SCHEMA)),
      `import { hook, type AfterChange } from "./hooks.ts"

const notify: AfterChange<"posts"> = async (ctx) => {
  const titles: string[] = ctx.rows.map((r) => r.title)
  const key: string = ctx.deliveryId
  if (ctx.operation === "update") {
    const before: string[] = ctx.old.map((r) => r.title)
    void before
  }
  void titles
  void key
}

export default hook(notify)
`,
    )
    expect(output).toBe("")
  })

  it("leaves a restricted column out of a hook that did not ask for every column", () => {
    const output = compileWithHandler(
      generateHooksModule(astFor(RESTRICTED_SCHEMA)),
      `import type { AfterChange } from "./hooks.ts"

const notify: AfterChange<"posts"> = async (ctx) => {
  void ctx.rows[0]?.secretNote
}

export default notify
`,
    )
    expect(output).toContain("secretNote")
  })

  it("has no old rows on an insert", () => {
    const output = compileWithHandler(
      generateHooksModule(astFor(RESTRICTED_SCHEMA)),
      `import type { AfterChange } from "./hooks.ts"

const notify: AfterChange<"posts"> = async (ctx) => {
  if (ctx.operation === "insert") void ctx.old
}

export default notify
`,
    )
    expect(output).toContain("old")
  })

  it("keeps a restricted column for a hook that declared columns: all", () => {
    const output = compileWithHandler(
      generateHooksModule(astFor(RESTRICTED_SCHEMA)),
      `import type { AfterDelete } from "./hooks.ts"

const audit: AfterDelete<"posts"> = async (ctx) => {
  const notes: string[] = ctx.old.map((r) => r.secretNote)
  void notes
}

export default audit
`,
    )
    expect(output).toBe("")
  })

  it("passes the old rows and the delivery id from the payload to the handler", () => {
    const module = generateHooksModule(astFor(RESTRICTED_SCHEMA)) ?? ""
    expect(module).toContain('...(wire["old"] !== undefined && { old: wire["old"] })')
    expect(module).toContain('...(deliveryId !== undefined && { deliveryId })')
  })

  // One call per transaction, table and operation: the comments are what a handler author reads to
  // know that, and that `old[i]` is the row `rows[i]` was.
  it("says what one call holds and how its delivery id is built", () => {
    const module = generateHooksModule(astFor(RESTRICTED_SCHEMA)) ?? ""
    expect(module).toContain("one transaction")
    expect(module).toContain("`old[i]` is `rows[i]` as it was")
    expect(module).toContain("`commitLSN:schema.table:operation`")
    expect(module).toContain("in the JSON shape PostgREST returns")
  })
})

describe("field validators", () => {
  const VALIDATED_SCHEMA = `
import type { JSON, Model, Public, UUID } from "@supatype/types"

export type Product = Model<{
  id: UUID
  sku: string
  setupItems: JSON<{ label: string }[]>
}, {
  access: { read: Public }
  validate: { setupItems: "check-setup-items", sku: { function: "check-sku", timeout: 3000 } }
}>
`

  it("generates the module for a model that declares only validators", () => {
    // Validators need the same row types hooks do. A model declaring only validators used to produce
    // no module at all, which would make `FieldValidator<"product", ...>` fail to resolve.
    const module = generateHooksModule(astFor(VALIDATED_SCHEMA))
    expect(module).not.toBeNull()
    expect(module).toContain("FieldValidator")
    expect(module).toContain("export function fieldValidator(")
  })

  it("typechecks with a validator written the way the docs will show it", () => {
    const output = compileWithHandler(
      generateHooksModule(astFor(VALIDATED_SCHEMA)),
      `import { fieldValidator, type FieldValidator } from "./hooks.ts"

// The value is the column's real type, so this narrows without a cast.
const checkItems: FieldValidator<"product", "setupItems"> = (ctx) => {
  if (!Array.isArray(ctx.value) || ctx.value.length === 0) {
    return "At least one setup item is required."
  }
  return true
}

export default fieldValidator(checkItems)
`,
    )
    expect(output, "the generated validator surface must compile").toBe("")
  })
})
