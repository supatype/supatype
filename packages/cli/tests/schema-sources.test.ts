import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { gzipSync } from "node:zlib"
import { collectSchemaSourcePaths } from "../src/type-extractor.js"
import {
  packSchemaSources,
  buildSchemaSourcesPayload,
  restoreSchemaSourcesFromGz,
  findOrphanSchemaFiles,
} from "../src/schema-sources.js"
import { plainTarball } from "./support/tar-fixture.js"

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

  // macOS hands out temp dirs as /var/... while their real path is /private/var/..., and any
  // project opened through a symlinked directory has the same split. The entry is resolved to its
  // real path, so the root must be too, or every file looks like it is outside the project.
  it("accepts a project root reached through a symlink", () => {
    const real = join(tmp, "real-project")
    const link = join(tmp, "linked-project")
    mkdirSync(real)
    symlinkSync(real, link, "junction")
    writeMultiFileSchema(real)
    const graph = collectSchemaSourcePaths(join(link, "schema", "index.ts"), link)
    expect(graph.entryPoint).toBe("schema/index.ts")
    expect(graph.files.map((f) => f.relativePath)).toContain("schema/models/album.ts")
  })

  it("roundtrips tar+gzip bytes", () => {
    writeMultiFileSchema(tmp)
    const graph = collectSchemaSourcePaths(join(tmp, "schema", "index.ts"), tmp)
    const out = mkdtempSync(join(tmpdir(), "supatype-schema-restore-"))
    try {
      restoreSchemaSourcesFromGz(gzipSync(packSchemaSources(graph)), out)
      for (const file of graph.files) {
        expect(readFileSync(join(out, file.relativePath)).equals(readFileSync(file.absolutePath))).toBe(true)
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  // `<root>2/x.ts` starts with the root's own path and is beside it, not under it. As an absolute
  // name (or a drive spec on Windows) the tar reader marks it unsafe before the landing check.
  it("refuses an entry that lands beside the project under a name starting with its own", () => {
    writeMultiFileSchema(tmp)
    const graph = collectSchemaSourcePaths(join(tmp, "schema", "index.ts"), tmp)
    const [first] = graph.files
    if (first === undefined) throw new Error("no schema files")
    const beside = { ...first, relativePath: `${resolve(tmp)}2/evil.ts`.replace(/\\/g, "/") }
    const gz = gzipSync(packSchemaSources({ ...graph, files: [beside] }))
    expect(() => restoreSchemaSourcesFromGz(gz, tmp)).toThrow(/unsafe entry name/)
  })

  // The snapshot is read by the same tar reader as `init --example`, so it gets the same name checks.
  it("restores a name that only starts with two dots", () => {
    expect(restoreSchemaSourcesFromGz(plainTarball([{ path: "..notes/x.ts", content: "x" }]), tmp)).toEqual([
      "..notes/x.ts",
    ])
    expect(readFileSync(join(tmp, "..notes", "x.ts"), "utf8")).toBe("x")
  })

  it("refuses an entry that resolves to the project root itself", () => {
    for (const path of ["./", "."]) {
      expect(() => restoreSchemaSourcesFromGz(plainTarball([{ path, content: "x" }]), tmp)).toThrow(
        /does not land inside/,
      )
    }
  })

  it.each([
    ["a backslash rather than reading it as a separator", "schema\\models\\album.ts"],
    ["a colon, which names an NTFS stream on Windows", "schema/models/a:b.ts"],
  ])("refuses %s", (_label, path) => {
    expect(() => restoreSchemaSourcesFromGz(plainTarball([{ path, content: "x" }]), tmp)).toThrow(/unsafe/)
  })

  it("restore refuses a snapshot with an unsafe name before writing any file", () => {
    const gz = plainTarball([
      { path: "schema/index.ts", content: "x" },
      { path: "../escape.ts", content: "x" },
    ])
    expect(() => restoreSchemaSourcesFromGz(gz, tmp)).toThrow(/unsafe/)
    expect(existsSync(join(tmp, "schema", "index.ts"))).toBe(false)
  })

  // The manifest comes back from the database as the archive does, and its paths were never
  // checked: the backup takes the archive's checked entries, the files restore overwrites.
  it("restore backs up the checked files it overwrites", () => {
    const project = join(tmp, "project")
    const backupDir = join(tmp, "backups", "1")
    mkdirSync(join(project, "schema"), { recursive: true })
    writeFileSync(join(project, "schema", "index.ts"), "old\n")
    const gz = plainTarball([{ path: "schema/index.ts", content: "new\n" }])
    restoreSchemaSourcesFromGz(gz, project, { backupDir })
    expect(readFileSync(join(backupDir, "schema", "index.ts"), "utf8")).toBe("old\n")
    expect(readFileSync(join(project, "schema", "index.ts"), "utf8")).toBe("new\n")
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

    restoreSchemaSourcesFromGz(payload.gz, tmp)
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
