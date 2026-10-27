import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeSchema(source: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "supatype-qtoken-"))
  dirs.push(dir)
  const path = join(dir, "schema.ts")
  writeFileSync(path, source, "utf8")
  return { dir, path }
}

describe("a `?` on a model field", () => {
  it("is refused, naming model.field and pointing at Optional<>", () => {
    const { dir, path } = writeSchema(`
import type { Model, UUID } from "@supatype/types"

export type Task = Model<{
  id: UUID
  due?: string
}>
`)
    expect(() => extractSchemaAstFromTypes(path, dir)).toThrow(/Task\.due.*Optional<string>/s)
  })

  it("leaves an Optional<> field nullable", () => {
    const { dir, path } = writeSchema(`
import type { Model, UUID, Optional } from "@supatype/types"

export type Task = Model<{
  id: UUID
  due: Optional<string>
}>
`)
    const ast = extractSchemaAstFromTypes(path, dir)
    expect(ast?.models[0]?.fields["due"]).toMatchObject({ required: false })
  })
})
