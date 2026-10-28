import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  cpSync,
} from "node:fs"
import { join, resolve, relative } from "node:path"
import { gzipSync } from "node:zlib"
import { collectSchemaSourcePaths, type SchemaSourceGraph } from "./type-extractor.js"
import { loadConfig } from "./config.js"
import { projectRootFromConfig, schemaPathFromProject } from "./project-config.js"
import { projectAuthor } from "./push-audit.js"
import { readTar, readTarGz, type TarEntry } from "./tar-reader.js"
import { isArrayOf, isNumber, isOneOf, isShape, isString, optional, resolveInside, type Guard } from "@supatype/shared"

const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024
const WARN_COMPRESSED_BYTES = 512 * 1024

export interface SchemaSourcesManifest {
  version: number
  format: "tar+gzip"
  entryPoint: string
  fileCount: number
  uncompressedBytes: number
  compressedBytes: number
  files: Array<{ path: string; sha256: string; bytes: number }>
  pushedBy?: string
}

/** A manifest as `buildSchemaSourcesPayload` writes it, read back from a migration's snapshot. */
export const isSchemaSourcesManifest: Guard<SchemaSourcesManifest> = isShape({
  version: isNumber,
  format: isOneOf(["tar+gzip"] as const),
  entryPoint: isString,
  fileCount: isNumber,
  uncompressedBytes: isNumber,
  compressedBytes: isNumber,
  files: isArrayOf(isShape({ path: isString, sha256: isString, bytes: isNumber })),
  pushedBy: optional(isString),
})

export interface SchemaSourcesPayload {
  manifest: SchemaSourcesManifest
  dataBase64: string
  gz: Buffer
}

function padTarField(value: string, len: number): string {
  return value.slice(0, len).padEnd(len, "\0")
}

function tarChecksum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i]!
  }
  return sum
}

function writeTarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0)
  const size = content.length
  header.write(padTarField(name, 100), 0, 100, "ascii")
  header.write("0000644\0", 100, 8, "ascii")
  header.write("0000000\0", 108, 8, "ascii")
  header.write("0000000\0", 116, 8, "ascii")
  header.write(padTarField(size.toString(8), 11), 124, 12, "ascii")
  header.write("00000000000\0", 136, 12, "ascii")
  header.write("        ", 148, 8, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  const chk = tarChecksum(header)
  header.write(chk.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")

  const pad = (512 - (size % 512)) % 512
  return Buffer.concat([header, content, Buffer.alloc(pad)])
}

export function packSchemaSources(graph: SchemaSourceGraph): Buffer {
  const chunks: Buffer[] = []
  for (const file of graph.files) {
    const content = readFileSync(file.absolutePath)
    chunks.push(writeTarEntry(file.relativePath.replace(/\\/g, "/"), content))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

export function unpackSchemaSources(tar: Buffer, projectRoot: string): Map<string, Buffer> {
  return schemaSourceFiles(readTar(tar), projectRoot)
}

/**
 * The snapshot's files by path, refusing the whole snapshot on any entry the tar reader marks unsafe
 * or that does not land inside the project (the root itself included: a file cannot be written there).
 * Every file in it is one restore writes, so one bad name stops it before anything is written.
 */
function schemaSourceFiles(entries: readonly TarEntry[], projectRoot: string): Map<string, Buffer> {
  const root = resolve(projectRoot)
  const out = new Map<string, Buffer>()
  for (const entry of entries) {
    if (entry.kind !== "file") continue
    if (!entry.safe) throw new Error(`The schema snapshot has an unsafe entry name: ${JSON.stringify(entry.path)}`)
    if (resolveInside(root, entry.path) === undefined) {
      throw new Error(`The schema snapshot has a file that does not land inside ${root}: ${JSON.stringify(entry.path)}`)
    }
    out.set(entry.path, Buffer.from(entry.data))
  }
  return out
}

/**
 * The schema's source files, packed, with a manifest naming who pushed them: the same author the
 * migration row's `pushed_by` records ({@link projectAuthor}).
 */
export function buildSchemaSourcesPayload(
  cwd: string,
  pushedBy: string = projectAuthor(cwd),
): SchemaSourcesPayload | null {
  const config = loadConfig(cwd)
  const root = projectRootFromConfig(config, cwd)
  const entry = schemaPathFromProject(config, cwd)
  const graph = collectSchemaSourcePaths(entry, root)
  if (graph.files.length === 0) return null

  const tarBuf = packSchemaSources(graph)
  const gz = gzipSync(tarBuf, { level: 9 })

  if (gz.length > MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Schema snapshot too large (${(gz.length / 1024).toFixed(0)} KB compressed, max 2 MB). Split schema modules.`,
    )
  }
  if (gz.length > WARN_COMPRESSED_BYTES) {
    console.warn(`Warning: large schema snapshot (${(gz.length / 1024).toFixed(0)} KB compressed).`)
  }

  const manifest: SchemaSourcesManifest = {
    version: 1,
    format: "tar+gzip",
    entryPoint: graph.entryPoint,
    fileCount: graph.files.length,
    uncompressedBytes: graph.files.reduce((s, f) => s + f.bytes, 0),
    compressedBytes: gz.length,
    files: graph.files.map((f) => ({ path: f.relativePath, sha256: f.sha256, bytes: f.bytes })),
    ...(pushedBy ? { pushedBy } : {}),
  }

  return {
    manifest,
    dataBase64: gz.toString("base64"),
    gz,
  }
}

export function cacheSchemaSourcesLocally(cwd: string, migrationName: string, gz: Buffer): void {
  const dir = join(cwd, ".supatype", "schema-snapshots")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${migrationName}.tar.gz`), gz)
}

/**
 * Write the snapshot's files into the project, first copying each one it overwrites into
 * `backupDir`. Only the snapshot's checked entries are backed up and written, never a path the
 * manifest names: both come back from the database, and only the entries have been checked.
 */
export function restoreSchemaSourcesFromGz(gz: Buffer, projectRoot: string, opts?: { backupDir?: string }): string[] {
  const files = schemaSourceFiles(readTarGz(gz), projectRoot)
  const root = resolve(projectRoot)
  const restored: string[] = []

  if (opts?.backupDir) {
    mkdirSync(opts.backupDir, { recursive: true })
    for (const rel of files.keys()) {
      const abs = join(root, rel)
      if (existsSync(abs)) {
        const dest = join(opts.backupDir, rel)
        mkdirSync(join(dest, ".."), { recursive: true })
        cpSync(abs, dest)
      }
    }
  }

  for (const [rel, content] of files) {
    const abs = join(root, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
    restored.push(rel)
  }

  return restored
}

export function findOrphanSchemaFiles(
  projectRoot: string,
  entryPoint: string,
  manifestPaths: Set<string>,
): string[] {
  const entry = resolve(projectRoot, entryPoint)
  const graph = collectSchemaSourcePaths(entry, projectRoot)
  const orphans: string[] = []
  const schemaDir = join(projectRoot, graph.entryPoint.split("/").slice(0, -1).join("/") || ".")
  if (!existsSync(schemaDir)) return orphans

  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.(ts|tsx)$/.test(ent.name)) continue
      const rel = relative(projectRoot, abs).replace(/\\/g, "/")
      if (!manifestPaths.has(rel) && !graph.files.some((f) => f.relativePath === rel)) {
        orphans.push(rel)
      }
    }
  }
  walk(schemaDir)
  return orphans
}

export interface SchemaSourcePushArtifacts {
  gzPath: string
  manifestPath: string
  /** Paths inside the Docker /project bind mount. */
  dockerGzPath: string
  dockerManifestPath: string
  payload: SchemaSourcesPayload
}

/** Write schema source blob + manifest under `.supatype/` for engine push (CLI + dev watch). */
export function writeSchemaSourcePushArtifacts(cwd: string): SchemaSourcePushArtifacts | null {
  const payload = buildSchemaSourcesPayload(cwd)
  if (!payload) return null

  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  const gzPath = join(dir, "schema-sources-push.gz")
  const manifestPath = join(dir, "schema-sources-manifest.json")
  writeFileSync(gzPath, payload.gz)
  writeFileSync(manifestPath, JSON.stringify(payload.manifest))

  return {
    gzPath,
    manifestPath,
    dockerGzPath: "/project/.supatype/schema-sources-push.gz",
    dockerManifestPath: "/project/.supatype/schema-sources-manifest.json",
    payload,
  }
}
