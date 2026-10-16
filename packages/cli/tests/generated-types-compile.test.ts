/**
 * The generated client augmentation, compiled against the real `@supatype/client` with a consumer
 * that says what each column and each select should come back as.
 *
 * The generator's string tests check the text it writes. These check what that text means to
 * TypeScript, which is the claim a project relies on: a schema goes in, `supatype generate` writes
 * the augmentation, and `createClient().from(...).select(...)` is typed from it with no hand-written
 * row types. Cloud's content project had to hand-write them (`apps/www/src/lib/content-rows.ts`)
 * because three of these assertions failed against the generated output:
 *
 *   a localized column        was typed as the bare value, while the API returns a locale map
 *   `JSON<T>`                 lost `T` and came back as an opaque object
 *   an embedded select        was typed as the base row, so the joined shapes had to be declared
 *
 * Each assertion fails to compile on the output that had the defect, which is what makes it a test.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const SCHEMA = `
import type {
  HasMany, JSON, Localized, ManyToMany, Model, Optional, RelatedTo, Timestamp, UUID,
} from "@supatype/types"

export type Feature = { title: string; description: string; icon: string }

export type Settings = {
  theme: "light" | "dark"
  flags?: string[]
  limits: { [key: string]: number } | null
}

export type Author = Model<{
  id: UUID
  name: string
  posts: HasMany<Post>
}, { tableName: "authors" }>

export type Tag = Model<{
  id: UUID
  label: Localized<string>
  posts: ManyToMany<Post, { through: "post_tags" }>
}, { tableName: "tags" }>

export type Post = Model<{
  id: UUID
  title: Localized<string>
  features: Optional<Localized<JSON<Feature[]>>>
  settings: JSON<Settings>
  untyped: Optional<JSON>
  author: RelatedTo<Author, { required: true }>
  tags: ManyToMany<Tag, { through: "post_tags" }>
  published_at: Optional<Timestamp>
}, { tableName: "posts" }>
`

const PRELUDE = `
import { createClient, type TableRow } from "@supatype/client"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assert<T extends true>(): void
const client = createClient({ url: "http://localhost:1", anonKey: "k" })
type RowOf<Q> = Q extends PromiseLike<{ data: infer D }> ? NonNullable<D> extends Array<infer R> ? R : never : never
void client
`

/** Compile `consumer` beside the generated augmentation; returns every diagnostic as text. */
function compile(dir: string, consumer: string): string[] {
  const file = join(dir, "consumer.ts")
  writeFileSync(file, `${PRELUDE}\n${consumer}\nexport {}\n`)
  const program = ts.createProgram([join(dir, "index.d.ts"), file], {
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: {
      "@supatype/client": [join(PACKAGES, "client/src/index.ts")],
      "@supatype/types/lexical": [join(PACKAGES, "types/src/lexical.ts")],
    },
  })
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && resolve(d.file.fileName) === resolve(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
}

describe("the generated augmentation, as TypeScript reads it", () => {
  let dir = ""

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-gen-compile-"))
    mkdirSync(join(dir, "schema"))
    writeFileSync(join(dir, "schema/index.ts"), SCHEMA)
    const ast = extractSchemaAstFromTypes("schema/index.ts", dir)
    writeFileSync(join(dir, "index.d.ts"), generateClientAugmentation(ast))
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("types a localized column as the locale map the API returns", () => {
    expect(
      compile(dir, `
        assert<Equal<TableRow<"posts">["title"], { [locale: string]: string }>>()
        assert<Equal<TableRow<"tags">["label"], { [locale: string]: string }>>()
      `),
    ).toEqual([])
  })

  it("keeps the T of JSON<T>, inside a locale map too", () => {
    expect(
      compile(dir, `
        type Feature = { title: string; description: string; icon: string }
        type Settings = { theme: "light" | "dark"; flags?: string[]; limits: { [key: string]: number } | null }
        assert<Equal<TableRow<"posts">["features"], { [locale: string]: Feature[] } | null>>()
        assert<Equal<TableRow<"posts">["settings"], Settings>>()
      `),
    ).toEqual([])
  })

  it("infers the joined shapes from an embedded select string", () => {
    expect(
      compile(dir, `
        const q = client.from("posts").select("*, author:authors(*), tags:post_tags(tag:tags(*))")
        type Post = RowOf<typeof q>
        assert<Equal<Post["title"], { [locale: string]: string }>>()
        assert<Equal<Post["author"], TableRow<"authors"> | null>>()
        assert<Equal<Post["tags"], Array<{ tag: TableRow<"tags"> | null }>>>()
      `),
    ).toEqual([])
  })

  it("infers columns, aliases, inner joins and the reverse side of a relation", () => {
    expect(
      compile(dir, `
        const picked = client.from("posts").select("id, heading:title, author:authors!inner(name)")
        assert<Equal<RowOf<typeof picked>, {
          id: string
          heading: { [locale: string]: string }
          author: { name: string }
        }>>()
        const authors = client.from("authors").select("name, posts(id)")
        assert<Equal<RowOf<typeof authors>, { name: string; posts: Array<{ id: string }> }>>()
        const tags = client.from("tags").select("id, posts(id)")
        assert<Equal<RowOf<typeof tags>, { id: string; posts: Array<{ id: string }> }>>()
      `),
    ).toEqual([])
  })

  it("names a column the table does not have, where the value is used", () => {
    const errors = compile(dir, `
      const q = client.from("posts").select("id, nope")
      const value: string = (null as unknown as RowOf<typeof q>).nope
      void value
    `)
    expect(errors.join("\n")).toMatch(/column 'nope' does not exist on 'posts'/)
  })

  it("types a select string known only at run time as the whole row", () => {
    expect(
      compile(dir, `
        const columns: string = "id"
        const q = client.from("posts").select(columns)
        assert<Equal<RowOf<typeof q>, TableRow<"posts">>>()
      `),
    ).toEqual([])
  })
})
