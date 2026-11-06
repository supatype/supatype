/**
 * `JSON<T>` keeps its `T` when TypeScript's lib files are not on disk.
 *
 * The extractor asks the type checker what `T` is, and the checker needs `lib.es2022.d.ts` and the
 * files it references to know `Array` and `Record`. Run from npm as Node, the CLI found them beside
 * `typescript/lib/typescript.js`. Since 0.9.0 npm runs the Bun-compiled program, which carries the
 * compiler's JavaScript but not its lib files, and the path it looks them up at is the build
 * machine's. Without them `string[]` came out as `{}` and `Record<string, X>` as `Json` (issue #27).
 *
 * The compiled program's view is reproduced here exactly: the lib directory reads as absent.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"
import { generateProjectClient } from "../src/client-generator.js"
import { TYPESCRIPT_LIB_FILES, TYPESCRIPT_LIB_VERSION } from "../src/generated/typescript-libs.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const SCHEMA = `
import type { Default, JSON, Model, UUID } from "@supatype/types"

export type Survey = Model<{
  id: UUID
  options: Default<JSON<string[]>, "[]">
  answers: JSON<{ [key: string]: boolean | string | number }>
  scores: JSON<Record<string, number>>
}, { tableName: "surveys" }>
`

const EXPECTED: Record<string, string> = {
  options: "string[]",
  answers: "{ [key: string]: boolean | string | number }",
  scores: "{ [key: string]: number }",
}

const LIB_DIR = resolve(dirname(ts.getDefaultLibFilePath({})))

function inLibDir(fileName: string): boolean {
  return resolve(fileName).startsWith(LIB_DIR)
}

/** What the compiled program sees: no file under TypeScript's lib directory. */
function hideLibFiles(): void {
  const readFile = ts.sys.readFile.bind(ts.sys)
  const fileExists = ts.sys.fileExists.bind(ts.sys)
  vi.spyOn(ts.sys, "readFile").mockImplementation((f, enc) => (inLibDir(f) ? undefined : readFile(f, enc)))
  vi.spyOn(ts.sys, "fileExists").mockImplementation((f) => !inLibDir(f) && fileExists(f))
}

/** Every type written for `field` in `generated`: one each for Row, Insert and Update. */
function typesOf(generated: string, field: string): string[] {
  const line = new RegExp(`^\\s*${field}\\??: (.+)$`, "gm")
  return [...generated.matchAll(line)].map((m) => m[1] ?? "")
}

describe("JSON<T> with TypeScript's lib files absent, as in the compiled CLI", () => {
  let dir = ""
  let ast: ReturnType<typeof extractSchemaAstFromTypes> = null

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-json-nolib-"))
    mkdirSync(join(dir, "schema"))
    writeFileSync(join(dir, "schema/index.ts"), SCHEMA)
    hideLibFiles()
    ast = extractSchemaAstFromTypes("schema/index.ts", dir)
  })

  afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it("hides the lib files, so the test runs without them", () => {
    expect(ts.sys.fileExists(ts.getDefaultLibFilePath({}))).toBe(false)
  })

  it("gives the engine T for the database types file", () => {
    const fields = ast?.models.find((m) => m.name === "Survey")?.fields ?? {}
    const tsTypes = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, fields[k]?.["tsType"]]))
    expect(tsTypes).toEqual(EXPECTED)
  })

  it.each([
    ["the client augmentation", () => generateClientAugmentation(ast)],
    ["the project client", () => generateProjectClient(ast)],
  ])("writes T for Row, Insert and Update in %s", (_name, generate) => {
    const generated = generate()
    for (const [field, type] of Object.entries(EXPECTED)) {
      expect({ field, types: typesOf(generated, field) }).toEqual({ field, types: [type, type, type] })
    }
  })
})

describe("the lib files the CLI carries", () => {
  it("are the running TypeScript's own, so the compiler and its libs are one version", () => {
    const stale = "is stale: run node scripts/typescript-libs.mjs generate"
    expect(TYPESCRIPT_LIB_VERSION, stale).toBe(ts.version)
    for (const [name, text] of Object.entries(TYPESCRIPT_LIB_FILES)) {
      const onDisk = readFileSync(join(LIB_DIR, name), "utf8").replace(/\r\n/g, "\n")
      expect(text, `${name} ${stale}`).toBe(onDisk)
    }
  })
})
