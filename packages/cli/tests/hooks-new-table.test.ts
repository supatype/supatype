import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"
import { registerHooks } from "../src/commands/hooks.js"

/**
 * `hooks new` for a hook a model already names. It said `Wired to Note.beforeChange` and then
 * scaffolded `BeforeChange<"your_table">`, a handler typed against a table that does not exist.
 */
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("hooks-new")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, "schema"), { recursive: true })
})

afterEach(() => project.remove())

const handlerOf = (name: string): string => readFileSync(join(project.dir, "hooks", name, "index.ts"), "utf8")

describe("hooks new", () => {
  it("types a before hook against the table of the model that names it", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type Note = Model<{ id: UUID; body: string }, { hooks: { beforeChange: "tag-note" } }>
`)
    const run = await runCommand(registerHooks, ["hooks", "new", "tag-note"], project.dir)
    expect(run.output).toContain("Wired to Note.beforeChange")
    expect(handlerOf("tag-note")).toContain(`BeforeChange<"note">`)
  })

  it("types an after hook against its model's own table name", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type BlogPost = Model<{ id: UUID }, { tableName: "posts"; hooks: { afterChange: "index-post" } }>
`)
    await runCommand(registerHooks, ["hooks", "new", "index-post"], project.dir)
    expect(handlerOf("index-post")).toContain(`AfterChange<"posts">`)
  })

  it("types an afterDelete hook as one, since its context carries old rows and no new ones", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type BlogPost = Model<{ id: UUID }, { tableName: "posts"; hooks: { afterDelete: "purge-post" } }>
`)
    await runCommand(registerHooks, ["hooks", "new", "purge-post"], project.dir)
    const handler = handlerOf("purge-post")
    expect(handler).toContain(`AfterDelete<"posts">`)
    expect(handler).not.toContain("AfterChange")
    // Delivery is at least once, so the scaffold says how to drop a repeat.
    expect(handler).toContain("ctx.deliveryId")
  })
})

// Local test round 6c, N30: a hook made before any model named it imports `../_supatype/hooks.ts`,
// which only a push wrote, so in native dev it failed to load until the hook file was edited.
describe("hooks new and the generated adapter", () => {
  const adapterPath = (): string => join(project.dir, "hooks", "_supatype", "hooks.ts")

  it("writes the adapter when it is missing, though no model names the hook yet", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type Note = Model<{ id: UUID; body: string }>
`)
    await runCommand(registerHooks, ["hooks", "new", "tag-note"], project.dir)
    expect(readFileSync(adapterPath(), "utf8")).toMatch(/export function hook\b/)
  })

  it("writes the adapter for the current schema's hooked tables", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type Note = Model<{ id: UUID; body: string }, { hooks: { beforeChange: "tag-note" } }>
`)
    await runCommand(registerHooks, ["hooks", "new", "tag-note"], project.dir)
    expect(readFileSync(adapterPath(), "utf8")).toContain(`"note": {`)
  })

  it("leaves an adapter that is already there alone", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), `import type { Model, UUID } from "@supatype/types"
export type Note = Model<{ id: UUID; body: string }>
`)
    mkdirSync(join(project.dir, "hooks", "_supatype"), { recursive: true })
    writeFileSync(adapterPath(), "// pushed\n")
    await runCommand(registerHooks, ["hooks", "new", "tag-note"], project.dir)
    expect(readFileSync(adapterPath(), "utf8")).toBe("// pushed\n")
  })
})

// S-8: a name a model gives to `validate` is a field validator, not a hook. `hooks new` scaffolded a
// `beforeChange` for it and said no model references it, and `hooks list` left validators out.
describe("hooks new and hooks list for a field validator", () => {
  const validatorSchema = `import type { Model, UUID } from "@supatype/types"
export type Product = Model<{ id: UUID; title: string }, { tableName: "product"; validate: { title: "check-title" } }>
`

  it("scaffolds a field validator typed against the table and field, and says where it is wired", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), validatorSchema)
    const run = await runCommand(registerHooks, ["hooks", "new", "check-title"], project.dir)
    expect(run.output).toContain("Wired to Product.title (validator)")
    expect(run.output).not.toContain("No model references it yet")
    const handler = handlerOf("check-title")
    expect(handler).toContain(`FieldValidator<"product", "title">`)
    expect(handler).toContain("export default fieldValidator(")
    expect(handler).not.toContain("BeforeChange")
  })

  it("lists the validators beside the hooks", async () => {
    writeFileSync(join(project.dir, "schema", "index.ts"), validatorSchema)
    const run = await runCommand(registerHooks, ["hooks", "list"], project.dir)
    expect(run.output).toContain("Product.title")
    expect(run.output).toContain("check-title")
  })
})
