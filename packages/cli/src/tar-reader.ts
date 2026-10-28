/**
 * Read a gzipped tarball in memory.
 *
 * Enough of the format for the archives GitHub serves (`git archive`: ustar headers, a pax global
 * header with the commit, pax `path` records for long names) and GNU long names. Written here
 * rather than shelling out to `tar`, which on Windows is often Git Bash's and refuses drive-letter
 * paths, and rather than adding a dependency for a few dozen lines.
 *
 * An archive names its own paths, so each entry says whether its name is one a consumer could write
 * safely ({@link isSafeEntryName}). An unsafe name does not spoil the archive: a consumer that takes
 * one folder of a whole repository refuses only an unsafe name it would use.
 */

import { gunzipSync } from "node:zlib"
import { errorMessage } from "./error-message.js"

export interface TarEntry {
  path: string
  kind: "file" | "directory"
  data: Buffer
  /** Whether the name can be written under a directory without landing outside it ({@link isSafeEntryName}). */
  safe: boolean
}

const BLOCK = 512

/** Every file and directory in `gz`, unsafe names included; links and other special entries are left out. */
export function readTarGz(gz: Buffer): TarEntry[] {
  return readTar(gunzip(gz))
}

function gunzip(gz: Buffer): Buffer {
  try {
    return gunzipSync(gz)
  } catch (err) {
    throw new Error(`The archive is not a gzipped tarball: ${errorMessage(err)}`)
  }
}

/** {@link readTarGz} for a tarball that is not compressed. */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let nextPath: string | undefined
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (header.toString("latin1", 257, 262) !== "ustar") throw new Error("The archive is not a tarball (no ustar header).")
    const size = octal(header.subarray(124, 136))
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size)
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCharCode(header[156] ?? 0)
    if (type === "x") nextPath = paxPath(data) ?? nextPath
    else if (type === "L") nextPath = cString(data)
    else if (type !== "g") {
      const kind = type === "5" ? "directory" : type === "0" || type === "\0" ? "file" : undefined
      const path = nextPath ?? headerPath(header)
      if (kind !== undefined) entries.push({ path, kind, data, safe: isSafeEntryName(path) })
      nextPath = undefined
    }
  }
  return entries
}

/**
 * False when `name` has a NUL, a backslash, an absolute start, a drive spec opening it or a `..`
 * segment. A backslash is a separator to Windows, so `..\..\x` climbs out there however POSIX reads
 * it, and `C:x` is relative to that drive's own working directory. A colon later in the name
 * (`docs/a:b.md`) is no drive: joined under a directory it stays there.
 */
export function isSafeEntryName(name: string): boolean {
  return !(/[\\\0]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."))
}

/** A ustar name, with its prefix field when it has one. */
function headerPath(header: Buffer): string {
  const name = cString(header.subarray(0, 100))
  const prefix = cString(header.subarray(345, 500))
  return prefix === "" ? name : `${prefix}/${name}`
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0)
  return bytes.toString("utf8", 0, end === -1 ? bytes.length : end)
}

function octal(field: Buffer): number {
  const text = cString(field).trim()
  if (text === "") return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`The tarball has an entry size it cannot read: "${text}".`)
  return parseInt(text, 8)
}

/** The `path` of a pax extended header: records of `<length> <key>=<value>\n`. */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined
  for (let offset = 0; offset < data.length; ) {
    const space = data.indexOf(0x20, offset)
    const length = parseInt(data.toString("latin1", offset, space), 10)
    if (space === -1 || !Number.isFinite(length) || length <= 0) break
    const record = data.toString("utf8", space + 1, offset + length - 1)
    const equals = record.indexOf("=")
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1)
    offset += length
  }
  return path
}
