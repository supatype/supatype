/**
 * Files a deploy writes into the project's own checkout: a function's files, a hook's handler.
 *
 * On self-host the functions and hooks directories are the project's checkout, so a deploy writes
 * over files someone edits. A function comes as its entry module (`source`) and, when it has more
 * than one file, every file by path (`files`). A JSON map of files in `source`, which older CLIs
 * send, is read as `files`, never written as the entry.
 *
 * Every path must stay inside the function's directory: relative, no `.` or `..` segments, and no
 * existing link or directory where a file goes. The whole deploy is checked before anything is
 * written, and a file whose content is already there is not written again.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
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

/** Writes each file whose contents differ from the disk, together, and leaves the rest untouched. */
export async function writeChanged(files: readonly DeployFile[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      if ((await readFile(file.path, "utf8").catch(() => null)) === file.source) return
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.source, "utf8")
    }),
  )
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

/**
 * Refuses (400) a file that would land on a link or directory, or outside the function's directory
 * (real path `base`, null while it does not exist yet) through a link.
 */
function assertLandsInside(fn: string, dir: { path: string; base: string | null }, target: string): void {
  if (existsSync(target) && !lstatSync(target).isFile()) {
    throw badRequest(`Function ${fn}: ${relative(dir.path, target)} exists and is not a regular file`)
  }
  if (dir.base === null) return
  let existing = dirname(target)
  while (!existsSync(existing) && existing !== dir.path) existing = dirname(existing)
  const real = realpathSync(existing)
  if (real !== dir.base && !pathInside(dir.base, real)) {
    throw badRequest(`Function ${fn}: ${relative(dir.path, target)} would be written outside the function's directory`)
  }
}

/** One deployed function, as {@link functionFiles} reads it. */
export interface DeployedFunction {
  name: string
  /** The function's directory, already checked against the function-name rule. */
  dir: string
  source: string
  files?: Record<string, string> | undefined
}

/**
 * The files a deployed function writes under its directory: `files` when given, else a map an older
 * CLI sent as `source`, else `source` alone as the entry. Every path is checked before anything is
 * written (see the file's comment); the directory's real path is looked up once.
 */
export function functionFiles(fn: DeployedFunction): DeployFile[] {
  const path = resolve(fn.dir)
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw badRequest(`Function ${fn.name}: its directory is a link or a file`)
  const dir = { path, base: existsSync(path) ? realpathSync(path) : null }
  const map = fn.files ?? legacyFileMap(fn.source) ?? { [ENTRY]: fn.source }
  const withEntry = isString(map[ENTRY]) ? map : { ...map, [ENTRY]: fn.source }
  return Object.entries(withEntry).map(([file, content]) => {
    const target = join(path, ...safeSegments(fn.name, file))
    assertLandsInside(fn.name, dir, target)
    return { path: target, source: content }
  })
}
