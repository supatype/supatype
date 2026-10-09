import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  applyColumnDeclaration,
  declareAdoptedColumns,
  fieldTypeForColumn,
  parseColumnKey,
  planColumnDeclaration,
  previewKeyedColumns,
  type DeclareDeps,
  type LiveColumn,
} from "../src/adopt-columns.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/** Adopting a column declares it: the field goes into the model whose table it is, or is printed. */

const POST = `import type {
  Model,
  Public,
  Timestamp,
  UUID,
} from "@supatype/types"

/** A post. */
export type Post = Model<{
  id: UUID
  // the headline
  title: string
  authorName: string // shown under the title
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: { read: Public }
}>
`

function col(name: string, udtName: string, extra: Partial<LiveColumn> = {}): LiveColumn {
  return { name, dataType: udtName, udtName, nullable: false, default: null, ...extra }
}

let dir: string
let entry: string

function write(rel: string, text: string): string {
  const path = join(dir, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adopt-columns-"))
  entry = write("schema/index.ts", POST)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function plan(table: string, live: LiveColumn | undefined) {
  return planColumnDeclaration({ entryPath: entry, cwd: dir, table, column: live?.name ?? "missing", live })
}

function declare(table: string, live: LiveColumn) {
  const planned = plan(table, live)
  if (planned.status !== "planned") throw new Error(`not planned: ${planned.reason}`)
  return applyColumnDeclaration(planned, entry, dir)
}

describe("fieldTypeForColumn()", () => {
  it("maps the types whose column a field declares exactly", () => {
    const text = (c: LiveColumn) => {
      const t = fieldTypeForColumn(c)
      if ("reason" in t) return t.reason
      return JSON.stringify(t.expr)
    }
    expect(text(col("a", "int4"))).toContain('"Int"')
    expect(text(col("a", "timestamptz"))).toContain('"Timestamp"')
    expect(text(col("a", "numeric", { numericPrecision: 10, numericScale: 2 }))).toContain('"Decimal"')
  })

  it("refuses a type no field declares exactly", () => {
    for (const c of [col("a", "varchar"), col("a", "timestamp"), col("a", "numeric"), col("a", "_text"), col("a", "mood")]) {
      expect(fieldTypeForColumn(c)).toHaveProperty("reason")
    }
  })
})

describe("declaring an adopted column", () => {
  it("inserts the field as the model's last field, keeping comments and layout", () => {
    const result = declare("post", col("subtitle", "text", { nullable: true }))
    expect(result.status).toBe("planned")
    const after = readFileSync(entry, "utf8")
    expect(after).toContain("  updated_at: Timestamp\n  subtitle: Optional<string>\n}, {")
    expect(after).toContain("// the headline\n  title: string")
    expect(after).toContain("authorName: string // shown under the title")
    // Optional was imported in the file's own style: one per line.
    expect(after).toContain("  UUID,\n  Optional,\n} from")
    const field = extractSchemaAstFromTypes(entry, dir)!.models[0]!.fields["subtitle"]!
    expect(field).toMatchObject({ kind: "text", required: false })
  })

  it("keys the field by the column name as it is, which is how a field key maps to its column", () => {
    // `authorName` is the column "authorName": the engine does not convert case, so a snake_case
    // column stays snake_case beside camelCase fields, and a camelCase one stays camelCase.
    declare("post", col("view_count", "int4", { default: "0" }))
    declare("post", col("readTime", "int2", { nullable: true }))
    const after = readFileSync(entry, "utf8")
    expect(after).toContain("view_count: ServerDefault<Int>")
    expect(after).toContain("readTime: Optional<SmallInt>")
    const fields = extractSchemaAstFromTypes(entry, dir)!.models[0]!.fields
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(["view_count", "readTime"]))
  })

  it("quotes a column name that is not an identifier", () => {
    declare("post", col("old-id", "uuid"))
    expect(readFileSync(entry, "utf8")).toContain('"old-id": UUID')
  })

  it("finds the model by its tableName, in an imported schema file, and uses an aliased import", () => {
    write("schema/index.ts", `export * from "./models/blog"\n`)
    const blog = write(
      "schema/models/blog.ts",
      `import type { Model, Public, Int as Integer } from "@supatype/types"\n` +
        `export type Article = Model<{ title: string; words: Integer }, { tableName: "articles"; access: { read: Public } }>\n`,
    )
    const result = declare("articles", col("rank", "int4"))
    expect(result).toMatchObject({ status: "planned", model: "Article", file: blog })
    expect(readFileSync(blog, "utf8")).toContain("{ title: string; words: Integer; rank: Integer }")
  })

  it("writes NotLocalized<string> in a localized model, where a bare string would become JSONB", () => {
    write(
      "schema/index.ts",
      `import type { LocalizedModel, Public } from "@supatype/types"\n` +
        `export type Page = LocalizedModel<{\n  title: string\n}, { access: { read: Public } }>\n`,
    )
    declare("page", col("legacy_ref", "text"))
    expect(readFileSync(entry, "utf8")).toContain("  legacy_ref: NotLocalized<string>\n")
    const field = extractSchemaAstFromTypes(entry, dir)!.models[0]!.fields["legacy_ref"]!
    expect(field["localized"]).toBeUndefined()
  })

  it("says what to add by hand when no model has the table", () => {
    const result = plan("ghosts", col("note", "text"))
    expect(result).toMatchObject({ status: "manual", line: "note: string" })
    expect(result.status === "manual" && result.reason).toContain("no model in the schema has table ghosts")
    expect(readFileSync(entry, "utf8")).toBe(POST)
  })

  it("says what to add by hand, naming file and model, when the type cannot be mapped exactly", () => {
    const result = plan("post", col("code", "varchar"))
    expect(result).toMatchObject({ status: "manual", model: "Post", file: entry })
    expect(result.status === "manual" && result.reason).toContain("varchar")
    expect(readFileSync(entry, "utf8")).toBe(POST)
  })

  it("does not choose a file when the model's fields are declared elsewhere", () => {
    write(
      "schema/index.ts",
      `import type { Model, Public } from "@supatype/types"\n` +
        `type PostFields = { title: string }\n` +
        `export type Post = Model<PostFields, { access: { read: Public } }>\n`,
    )
    const result = plan("post", col("note", "text"))
    expect(result).toMatchObject({ status: "manual", model: "Post", line: "note: string" })
  })

  it("puts the file back when the edit does not read back as planned", () => {
    const planned = plan("post", col("note", "text"))
    if (planned.status !== "planned") throw new Error("not planned")
    const broken = { ...planned, after: planned.after.replace("note: string", "note: Int") }
    const result = applyColumnDeclaration(broken, entry, dir)
    expect(result).toMatchObject({ status: "manual", line: planned.line })
    expect(readFileSync(entry, "utf8")).toBe(POST)
  })
})

describe("declareAdoptedColumns()", () => {
  const say = () => ({ info: vi.fn(), warn: vi.fn(), plain: vi.fn() })
  const deps = (over: Partial<DeclareDeps> = {}): DeclareDeps => ({
    introspect: async () => ({ tables: [{ name: "post", columns: [col("note", "text", { nullable: true })] }] }),
    confirm: vi.fn(async () => true),
    regenerate: vi.fn(async () => ["Types written to types/database.ts"]),
    say: say(),
    ...over,
  })
  const NOTE = [{ kind: "column", table: "post", name: "note" }]
  const all = (d: DeclareDeps) =>
    [...vi.mocked(d.say.info).mock.calls, ...vi.mocked(d.say.warn).mock.calls, ...vi.mocked(d.say.plain).mock.calls]
      .flat()
      .join("\n")

  it("does nothing for adopted objects that are not columns", async () => {
    const d = deps({ introspect: vi.fn() })
    await declareAdoptedColumns([{ kind: "table", table: "w", name: "w" }], { entryPath: entry, cwd: dir, yes: true, interactive: false }, d)
    expect(d.introspect).not.toHaveBeenCalled()
  })

  it("asks, then edits and regenerates, when a person agrees", async () => {
    const d = deps()
    await declareAdoptedColumns(NOTE, { entryPath: entry, cwd: dir, yes: false, interactive: true }, d)
    expect(d.confirm).toHaveBeenCalledTimes(1)
    expect(all(d)).toContain("note: Optional<string>")
    expect(readFileSync(entry, "utf8")).toContain("note: Optional<string>")
    expect(d.regenerate).toHaveBeenCalledTimes(1)
    expect(all(d)).toContain("next `supatype push` treats post.note as declared")
  })

  it("leaves the file alone and prints the line to add when a person declines", async () => {
    const d = deps({ confirm: vi.fn(async () => false) })
    await declareAdoptedColumns(NOTE, { entryPath: entry, cwd: dir, yes: false, interactive: true }, d)
    expect(readFileSync(entry, "utf8")).toBe(POST)
    expect(d.regenerate).not.toHaveBeenCalled()
    expect(all(d)).toContain("Add this field to model Post in schema/index.ts by hand")
  })

  it("edits without asking under --yes", async () => {
    const d = deps()
    await declareAdoptedColumns(NOTE, { entryPath: entry, cwd: dir, yes: true, interactive: false }, d)
    expect(d.confirm).not.toHaveBeenCalled()
    expect(readFileSync(entry, "utf8")).toContain("note: Optional<string>")
    expect(all(d)).toContain("Added `note: Optional<string>` to model Post in schema/index.ts")
    expect(d.regenerate).toHaveBeenCalledTimes(1)
  })

  it("says to run generate when regenerating fails, keeping the edit", async () => {
    const d = deps({ regenerate: vi.fn(async () => Promise.reject(new Error("boom"))) })
    await declareAdoptedColumns(NOTE, { entryPath: entry, cwd: dir, yes: true, interactive: false }, d)
    expect(readFileSync(entry, "utf8")).toContain("note: Optional<string>")
    expect(all(d)).toContain("run `supatype generate`")
  })

  it("prints what to declare when the database cannot be read", async () => {
    const d = deps({ introspect: async () => Promise.reject(new Error("refused")) })
    await declareAdoptedColumns(NOTE, { entryPath: entry, cwd: dir, yes: true, interactive: false }, d)
    expect(readFileSync(entry, "utf8")).toBe(POST)
    expect(all(d)).toContain("Declare a field note")
  })
})

describe("previewKeyedColumns()", () => {
  const introspectWith = (columns: LiveColumn[]) => async () => ({ tables: [{ name: "post", columns }] })
  const preview = (keys: string[], introspect: () => Promise<unknown>, shown: string[] = []) =>
    previewKeyedColumns(keys, shown, { entryPath: entry, cwd: dir }, { introspect })

  it("names the field, file and model the edit after adopt would write, and writes nothing", async () => {
    const lines = await preview(["column:post.subtitle"], introspectWith([col("subtitle", "text", { nullable: true })]))
    expect(lines).toEqual([
      'column post.subtitle: record as managed by Supatype, and add `subtitle: Optional<string>` to ' +
        `${join("schema", "index.ts")} (Post), importing Optional from "@supatype/types"`,
    ])
    // Exactly what the edit would add.
    const planned = plan("post", col("subtitle", "text", { nullable: true }))
    expect(planned.status === "planned" && planned.line).toBe("subtitle: Optional<string>")
    expect(readFileSync(entry, "utf8")).toBe(POST)
  })

  it("says to add the field by hand when it cannot be written safely", async () => {
    const [line] = await preview(["column:post.slug"], introspectWith([col("slug", "varchar")]))
    expect(line).toMatch(/^column post\.slug: record as managed by Supatype; declare it in your schema by hand \(/)
    const [taken] = await preview(["column:post.title"], introspectWith([col("title", "text")]))
    expect(taken).toBe(
      `column post.title: record as managed by Supatype; add it to your schema by hand in ${join("schema", "index.ts")} ` +
        "(Post): `title: string` (model Post already has a field named title)",
    )
    const [noModel] = await preview(["column:other.x"], async () => ({
      tables: [{ name: "other", columns: [col("x", "int4")] }],
    }))
    expect(noModel).toBe(
      "column other.x: record as managed by Supatype; add it to your schema by hand: `x: Int` (no model in the schema has table other)",
    )
  })

  it("says so when the database cannot be read", async () => {
    const [line] = await preview(["column:post.subtitle"], async () => {
      throw new Error("refused")
    })
    expect(line).toContain("its type could not be read from the database (refused)")
  })

  it("skips keys that are not columns, and columns the engine's preview already lists, without reading the database", async () => {
    const introspect = vi.fn(introspectWith([]))
    expect(await preview(["table:post", "column:post.title"], introspect, ["column:post.title"])).toEqual([])
    expect(introspect).not.toHaveBeenCalled()
  })

  it("parses column keys", () => {
    expect(parseColumnKey("column:post.a.b")).toEqual({ table: "post", column: "a.b" })
    expect(parseColumnKey("column:post")).toBeUndefined()
    expect(parseColumnKey("index:post.i")).toBeUndefined()
  })
})
