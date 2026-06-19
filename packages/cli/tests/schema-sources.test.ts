import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { collectSchemaSourcePaths } from "../src/type-extractor.js"
import {
  packSchemaSources,
  unpackSchemaSources,
  buildSchemaSourcesPayload,
  restoreSchemaSourcesFromGz,
  findOrphanSchemaFiles,
} from "../src/schema-sources.js"

function writeMultiFileSchema(root: string): void {
  mkdirSync(join(root, "schema", "models"), { recursive: true })
  mkdirSync(join(root, "schema", "shared"), { recursive: true })
  writeFileSync(
    join(root, "schema", "index.ts"),
    `export type { Album } from "./models/album"\nexport type { localeConfig } from "./shared/locale"\n`,
  )
  writeFileSync(
    join(root, "schema", "models", "album.ts"),
    `import type { Nullable } from "../shared/field-types"\nexport type Album = { id: string; title: Nullable<string> }\n`,
  )
  writeFileSync(
    join(root, "schema", "shared", "field-types.ts"),
    `export type Nullable<T> = T | null\n`,
  )
  writeFileSync(
    join(root, "schema", "shared", "locale.ts"),
    `export type localeConfig = { default: string }\n`,
  )
}

describe("schema-sources", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schema-sources-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("discovers multi-file graph from entry point", () => {
    writeMultiFileSchema(tmp)
    const entry = join(tmp, "schema", "index.ts")
    const graph = collectSchemaSourcePaths(entry, tmp)
    const paths = graph.files.map((f) => f.relativePath).sort()
    expect(paths).toEqual([
      "schema/index.ts",
      "schema/models/album.ts",
      "schema/shared/field-types.ts",
      "schema/shared/locale.ts",
    ])
    expect(graph.entryPoint).toBe("schema/index.ts")
  })

  it("roundtrips tar+gzip bytes", () => {
    writeMultiFileSchema(tmp)
    const graph = collectSchemaSourcePaths(join(tmp, "schema", "index.ts"), tmp)
    const tar = packSchemaSources(graph)
    const files = unpackSchemaSources(tar, tmp)
    for (const file of graph.files) {
      const original = readFileSync(file.absolutePath)
      const restored = files.get(file.relativePath.replace(/\\/g, "/"))
      expect(restored?.equals(original)).toBe(true)
    }
  })

  it("buildSchemaSourcesPayload includes manifest metadata", () => {
    writeMultiFileSchema(tmp)
    writeFileSync(
      join(tmp, "supatype.config.ts"),
      `export default ${JSON.stringify({
        project: { name: "demo" },
        database: { provider: "docker" },
        server: { mode: "dev" },
        app: { mode: "none" },
        schema: { path: "schema/index.ts", pg_schema: "public" },
      })}\n`,
    )
    const payload = buildSchemaSourcesPayload(tmp, "test@example.com")
    expect(payload).not.toBeNull()
    expect(payload!.manifest.fileCount).toBe(4)
    expect(payload!.manifest.pushedBy).toBe("test@example.com")
    expect(payload!.manifest.compressedBytes).toBeGreaterThan(0)
  })

  it("restore overwrites modified local files", () => {
    writeMultiFileSchema(tmp)
    writeFileSync(
      join(tmp, "supatype.config.ts"),
      `export default ${JSON.stringify({
        project: { name: "demo" },
        database: { provider: "docker" },
        server: { mode: "dev" },
        app: { mode: "none" },
        schema: { path: "schema/index.ts", pg_schema: "public" },
      })}\n`,
    )
    const payload = buildSchemaSourcesPayload(tmp)!
    const albumPath = join(tmp, "schema", "models", "album.ts")
    writeFileSync(albumPath, "// modified\n")

    restoreSchemaSourcesFromGz(payload.gz, payload.manifest, tmp)
    expect(readFileSync(albumPath, "utf8")).toContain("Nullable")
  })

  it("warns about orphan files not in snapshot", () => {
    writeMultiFileSchema(tmp)
    writeFileSync(join(tmp, "schema", "models", "experimental.ts"), "export type X = {}\n")
    const graph = collectSchemaSourcePaths(join(tmp, "schema", "index.ts"), tmp)
    const manifestPaths = new Set(graph.files.map((f) => f.relativePath))
    const orphans = findOrphanSchemaFiles(tmp, graph.entryPoint, manifestPaths)
    expect(orphans).toContain("schema/models/experimental.ts")
  })
})
