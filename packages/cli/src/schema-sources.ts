import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  cpSync,
} from "node:fs"
import { join, resolve, relative } from "node:path"
import { gzipSync, gunzipSync } from "node:zlib"
import { collectSchemaSourcePaths, type SchemaSourceGraph } from "./type-extractor.js"
import { loadConfig } from "./config.js"
import { projectRootFromConfig, schemaPathFromProject } from "./project-config.js"

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
  const root = resolve(projectRoot)
  const out = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim()
    if (!name) break
    const sizeOct = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim()
    const size = parseInt(sizeOct, 8) || 0
    const content = tar.subarray(offset, offset + size)
    offset += size + ((512 - (size % 512)) % 512)
    const rel = name.replace(/\\/g, "/")
    if (rel.startsWith("..") || rel.includes("/../")) {
      throw new Error(`Invalid tar path: ${name}`)
    }
    const dest = resolve(root, rel)
    if (!dest.startsWith(root)) {
      throw new Error(`Tar path escapes project root: ${name}`)
    }
    out.set(rel, Buffer.from(content))
  }
  return out
}

export function buildSchemaSourcesPayload(
  cwd: string,
  pushedBy?: string,
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

export function restoreSchemaSourcesFromGz(
  gz: Buffer,
  manifest: SchemaSourcesManifest,
  projectRoot: string,
  opts?: { backupDir?: string },
): string[] {
  const tar = gunzipSync(gz)
  const files = unpackSchemaSources(tar, projectRoot)
  const root = resolve(projectRoot)
  const restored: string[] = []

  if (opts?.backupDir) {
    mkdirSync(opts.backupDir, { recursive: true })
    for (const path of manifest.files) {
      const abs = join(root, path.path)
      if (existsSync(abs)) {
        const dest = join(opts.backupDir, path.path)
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

export function resolvePushedBy(): string {
  return (
    process.env["SUPATYPE_PUSHED_BY"] ??
    process.env["USER"] ??
    process.env["USERNAME"] ??
    "local"
  )
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
  const payload = buildSchemaSourcesPayload(cwd, resolvePushedBy())
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
