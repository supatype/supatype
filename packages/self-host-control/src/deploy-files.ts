/**
 * Files a deploy writes into the project's own checkout: a function's files, a hook's handler.
 *
 * On self-host the functions and hooks directories are the project's checkout, so a deploy writes
 * over files someone edits. A directory function used to arrive as a JSON map of its files in
 * `source`, and that text was written as its index.ts (round 6, N27). A function now comes as its
 * entry module (`source`) and, when it has more than one file, every file by path (`files`). A map
 * in `source`, which older CLIs send, is read as `files`.
 *
 * Every path must stay inside the function's directory: relative, no `.` or `..` segments, and no
 * existing link or directory where a file goes. The whole deploy is checked before anything is
 * written, and a file whose content is already there is not written again.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, posix, relative, resolve, win32 } from "node:path"
import { isRecordOf, isString, parseJsonObject, pathInside } from "@supatype/shared"
import { badRequest } from "./http.js"

/** A file a deploy writes: where, and what. */
export interface DeployFile {
  path: string
  source: string
}

const ENTRY = "index.ts"
const isFileMap = isRecordOf(isString)

/** Writes each file whose contents differ from the disk, and leaves the rest untouched. */
export function writeChanged(files: readonly DeployFile[]): void {
  for (const file of files) {
    if (existsSync(file.path) && readFileSync(file.path, "utf8") === file.source) continue
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.source, "utf8")
  }
}

/** The map of files an older CLI sent as a directory function's `source`, or null when it is a module. */
function legacyFileMap(source: string): Record<string, string> | null {
  const parsed = parseJsonObject(source)
  return parsed.ok && isFileMap(parsed.value) && isString(parsed.value[ENTRY]) ? parsed.value : null
}

/** The segments of a file path inside a function's directory, refused (400) unless it is one. */
function safeSegments(fn: string, path: string): string[] {
  const refuse = (why: string) => badRequest(`Function ${fn}: the file path ${JSON.stringify(path)} ${why}`)
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) throw refuse("is absolute")
  const segments = path.split(/[\\/]/)
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw refuse("must name a file inside the function's directory")
  return segments
}

/** Refuses (400) a file that would land on a link or directory, or outside `dir` through a link. */
function assertLandsInside(fn: string, dir: string, target: string): void {
  if (existsSync(target) && !lstatSync(target).isFile()) {
    throw badRequest(`Function ${fn}: ${relative(dir, target)} exists and is not a regular file`)
  }
  let existing = dirname(target)
  while (!existsSync(existing) && existing !== dir) existing = dirname(existing)
  if (!existsSync(dir)) return
  const real = realpathSync(existing)
  const base = realpathSync(dir)
  if (real !== base && !pathInside(base, real)) {
    throw badRequest(`Function ${fn}: ${relative(dir, target)} would be written outside the function's directory`)
  }
}

/**
 * The files a deployed function writes under `dir`: `files` when given (a map of path to content),
 * else a map an older CLI sent as `source`, else `source` alone as the entry. Every path is checked
 * before anything is written (see the file's comment).
 */
export function functionFiles(fn: string, dir: string, source: string, files: unknown): DeployFile[] {
  if (files !== undefined && !isFileMap(files)) throw badRequest(`Function ${fn}: files must map paths to file contents`)
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw badRequest(`Function ${fn}: its directory is a link or a file`)
  const map = files ?? legacyFileMap(source) ?? { [ENTRY]: source }
  const withEntry = isString(map[ENTRY]) ? map : { ...map, [ENTRY]: source }
  return Object.entries(withEntry).map(([path, content]) => {
    const target = join(resolve(dir), ...safeSegments(fn, path))
    assertLandsInside(fn, resolve(dir), target)
    return { path: target, source: content }
  })
}
