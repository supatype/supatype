/**
 * Files a deploy writes into the project's own checkout: a function's files, a hook's handler, the
 * manifest, the control plane's records.
 *
 * On self-host the functions and hooks directories are the project's checkout, so a deploy writes
 * over files someone edits; and the control plane mounts the Docker socket, so a write a link carried
 * out of the project could end as root on the host. Every file is built with {@link fileUnder}, which
 * refuses (400) a path that is not relative, a `.` or `..` segment, anything already at the path that
 * is not a regular file (a link counts, one that leads nowhere included), and a link anywhere on the
 * way that leads out of the directory. {@link writeChanged} checks again as it writes, and opens the
 * file without following a link where the platform can.
 *
 * A function comes as its entry module (`source`) and, when it has more than one file, every file by
 * path (`files`). A JSON map of files in `source`, which older CLIs send, is read as `files`. It is
 * written back in the form the project keeps it: `<name>.ts` or `<name>/`, never both.
 */
import { constants, lstatSync, realpathSync, type Stats } from "node:fs"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises"
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path"
import { FUNCTION_NAME_RULE, isFunctionName, isRecordOf, isString, parseJsonObject, pathInside, workerLoadsFile } from "@supatype/shared"
import { badRequest } from "./http.js"

/** A directory a deploy writes under: where it is, its real path once it exists, and what to call it. */
export interface WriteRoot {
  path: string
  real: string | null
  label: string
}

/**
 * A file a deploy writes: where, what, and the directory it must stay inside, with that directory's
 * real path when it already existed (looked up once, by {@link writeRoot}).
 */
export interface DeployFile {
  path: string
  source: string
  root: string
  rootReal: string | null
  /**
   * Written to a new file beside it and renamed over it, so a reader never sees it half-written:
   * the manifest, which the worker and the server read while a deploy may be rewriting it.
   */
  atomic?: true
}

const ENTRY = "index.ts"
const isFileMap = isRecordOf(isString)
/** Opens for writing without following a link at the file itself, where the platform has the flag. */
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
/** A temporary file for an atomic write: created new, never over anything already there. */
const TEMP_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)

/** What is at `path` itself, a link not followed; undefined when nothing is; refused when it cannot be asked. */
function entryAt(path: string, label: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false })
  } catch {
    throw badRequest(`${label}: ${path} cannot be written (a file stands where a directory should)`)
  }
}

/**
 * `path` as a directory files are written under. Refused when something other than a directory is
 * there, a link included, unless `mayBeLink` (a root the stack is configured with, such as the hooks
 * directory, may be one). Its real path is looked up once, here.
 */
export function writeRoot(path: string, label: string, opts: { mayBeLink?: boolean } = {}): WriteRoot {
  const abs = resolve(path)
  const entry = entryAt(abs, label)
  if (entry !== undefined && !entry.isDirectory() && !(opts.mayBeLink === true && entry.isSymbolicLink())) {
    throw badRequest(`${label}: its directory is a link or a file`)
  }
  return { path: abs, real: entry === undefined ? null : realOf(abs, label, abs), label }
}

/**
 * The real path of `path`, refused (400) when a link on the way leads nowhere. The native resolver,
 * as fs.promises.realpath is (writeOne compares the two): the JavaScript one leaves a Windows 8.3
 * short name (`RUNNER~1`) as it is, and the comparison then refused every write under one.
 */
function realOf(path: string, label: string, shown: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    throw badRequest(`${label}: ${shown} is a link that leads nowhere`)
  }
}

/** The segments of a file path inside a directory, refused (400) unless it is one. */
function safeSegments(label: string, path: string): string[] {
  const refuse = (why: string) => badRequest(`${label}: the file path ${JSON.stringify(path)} ${why}`)
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) throw refuse("is absolute")
  const segments = path.split(/[\\/]/)
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw refuse("must name a file inside its directory")
  // A drive (`C:`) or a Windows alternate data stream (`a.ts:x`) is never part of a file's name here.
  if (segments.some((s) => s.includes(":"))) throw refuse("must not contain a colon")
  return segments
}

/** Refuses (400) a file that would land on anything but a regular file, or leave `root` through a link. */
function assertLandsInside(root: WriteRoot, target: string): void {
  const shown = relative(root.path, target)
  const entry = entryAt(target, root.label)
  if (entry !== undefined && !entry.isFile()) throw badRequest(`${root.label}: ${shown} exists and is not a regular file`)
  let existing = dirname(target)
  while (existing !== root.path && entryAt(existing, root.label) === undefined) existing = dirname(existing)
  if (root.real === null) return
  const real = realOf(existing, root.label, shown)
  if (real !== root.real && !pathInside(root.real, real)) {
    throw badRequest(`${root.label}: ${shown} would be written outside its directory`)
  }
}

/** The file `path` (relative, `/` or `\` between its parts) under `root`, checked as the file's comment says. */
export function fileUnder(root: WriteRoot, path: string, source: string): DeployFile {
  const target = join(root.path, ...safeSegments(root.label, path))
  assertLandsInside(root, target)
  return { path: target, source, root: root.path, rootReal: root.real }
}

/** A stand-in for a file's write: a promise to use instead of writing, or undefined to write it. */
type FileWriter = (file: DeployFile) => Promise<void> | undefined

let fileWriter: FileWriter | null = null

/** @internal Tests: fail a write, as a full disk would, without one. */
export function setFileWriterForTests(writer: FileWriter | null): void {
  fileWriter = writer
}

/** Writes `file`, checking once more that nothing on its way became a link out of its root. */
async function writeOne(file: DeployFile): Promise<void> {
  const injected = fileWriter?.(file)
  if (injected !== undefined) return injected
  if ((await readFile(file.path, "utf8").catch(() => null)) === file.source) return
  await mkdir(dirname(file.path), { recursive: true })
  const [base, parent] = await Promise.all([file.rootReal ?? realpath(file.root), realpath(dirname(file.path))])
  if (parent !== base && !pathInside(base, parent)) throw badRequest(`${file.path} would be written outside its directory`)
  const entry = await lstat(file.path).catch(() => undefined)
  if (entry !== undefined && !entry.isFile()) throw badRequest(`${file.path} exists and is not a regular file`)
  if (file.atomic === true) return writeReplacing(file)
  await writeTo(file.path, WRITE_FLAGS, file.source)
}

/** Writes `source` to `path` opened with `flags`. */
async function writeTo(path: string, flags: number, source: string): Promise<void> {
  const handle = await open(path, flags, 0o644)
  try {
    await handle.writeFile(source, "utf8")
  } finally {
    await handle.close()
  }
}

/** Writes `file` to a new file in its directory and renames that over it; the new file is removed if this fails. */
async function writeReplacing(file: DeployFile): Promise<void> {
  const temp = join(dirname(file.path), `.${basename(file.path)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    await writeTo(temp, TEMP_FLAGS, file.source)
    await rename(temp, file.path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/**
 * Writes each file whose contents differ from the disk, together, and leaves the rest untouched.
 * Every write has finished before it rejects with the first failure, so a caller that undoes the
 * writes never races one still in flight.
 */
export async function writeChanged(files: readonly DeployFile[]): Promise<void> {
  const results = await Promise.allSettled(files.map(writeOne))
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed !== undefined) throw failed.reason
}

/** The map of files an older CLI sent as a directory function's `source`, or null when it is a module. */
function legacyFileMap(source: string): Record<string, string> | null {
  const parsed = parseJsonObject(source)
  return parsed.ok && isFileMap(parsed.value) && isString(parsed.value[ENTRY]) ? parsed.value : null
}

/** One deployed function, as {@link functionFiles} reads it. */
export interface DeployedFunction {
  /** Already checked against the function-name rule: one safe path segment. */
  name: string
  source: string
  files?: Record<string, string> | undefined
}

/**
 * What a deploy of one function does: the files it writes; the `<name>.ts` it removes when the
 * function is now a directory; and the source files under `<name>/` it clears: those `kept` does not
 * name, and with `pruneEmpty` the directory too once nothing is left in it.
 */
export interface FunctionWrite {
  files: DeployFile[]
  remove: string[]
  clear?: { name: string; kept: ReadonlySet<string>; pruneEmpty: boolean } | undefined
}

/**
 * The files a deployed function writes under the functions root, in the form the project keeps:
 * with `files` (or a map in `source`), the directory `<name>/`; with a single module, `<name>.ts`,
 * unless the project keeps the function as a directory and has no `<name>.ts`, when it is that
 * directory's index.ts. The other form, if it is there, is removed, so a name is never two routes.
 */
export function functionFiles(root: WriteRoot, fn: DeployedFunction): FunctionWrite {
  if (!isFunctionName(fn.name)) throw badRequest(`Invalid function name ${JSON.stringify(fn.name)}: ${FUNCTION_NAME_RULE}`)
  const map = fn.files ?? legacyFileMap(fn.source)
  const single = join(root.path, `${fn.name}.ts`)
  const dir = join(root.path, fn.name)
  const hasSingle = entryAt(single, root.label) !== undefined
  const hasDir = entryAt(dir, root.label) !== undefined
  if (map === null && (hasSingle || !hasDir)) {
    // The directory form goes, but only what the worker loads from it: notes and data stay.
    const clear = hasDir ? { name: fn.name, kept: new Set<string>(), pruneEmpty: true } : undefined
    return { files: [fileUnder(root, `${fn.name}.ts`, fn.source)], remove: [], clear }
  }
  const withEntry = map === null ? { [ENTRY]: fn.source } : isString(map[ENTRY]) ? map : { ...map, [ENTRY]: fn.source }
  // A redeploy of fewer files leaves no source the worker would still load.
  const clear = map === null ? undefined : { name: fn.name, kept: keptPaths(withEntry), pruneEmpty: false }
  return { files: filesInDir(root, fn.name, withEntry), remove: hasSingle ? [single] : [], clear }
}

/** The paths of `files` with `/` between their parts, as {@link sourcesNotKept} names them. */
export function keptPaths(files: Readonly<Record<string, string>>): Set<string> {
  return new Set(Object.keys(files).map((path) => path.split(/[\\/]/).join("/")))
}

/**
 * Clears what each write's `clear` names: the sources under its directory it does not keep, then,
 * with `pruneEmpty`, every directory left empty there, its own last.
 */
export async function clearAll(root: WriteRoot, writes: readonly FunctionWrite[]): Promise<void> {
  await Promise.all(
    writes.map(async ({ clear }) => {
      if (clear === undefined) return
      await removeAll(await sourcesNotKept(root, clear.name, clear.kept))
      if (clear.pruneEmpty) await pruneEmptyDirs(join(root.path, clear.name))
    }),
  )
}

/** Removes `dir` and every directory under it left empty, deepest first; never enters a link. */
async function pruneEmptyDirs(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => pruneEmptyDirs(join(dir, entry.name))))
  await rmdir(dir).catch(() => undefined)
}

/**
 * The files of `map` (path under the directory to content) under the directory `name` of `root`:
 * each path is checked on its own before it is put under that directory, then as a whole
 * ({@link fileUnder}), so one bad path refuses them all before anything is written.
 */
export function filesInDir(root: WriteRoot, name: string, map: Readonly<Record<string, string>>): DeployFile[] {
  return Object.entries(map).map(([file, content]) => fileUnder(root, [name, ...safeSegments(root.label, file)].join("/"), content))
}

/**
 * The source files (`workerLoadsFile`) under the directory `name` of `root` that `kept` does not
 * name: what an earlier deploy of more files left, which would otherwise still be loaded. A dot
 * directory and a link are never entered; anything else (a README, notes) is left alone.
 */
export async function sourcesNotKept(root: WriteRoot, name: string, kept: ReadonlySet<string>): Promise<string[]> {
  const walk = async (under: string): Promise<string[]> => {
    const entries = await readdir(join(root.path, name, under), { withFileTypes: true }).catch(() => [])
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = under === "" ? entry.name : `${under}/${entry.name}`
        if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : walk(path)
        return entry.isFile() && workerLoadsFile(path) && !kept.has(path) ? [join(root.path, name, path)] : []
      }),
    )
    return nested.flat()
  }
  return walk("")
}

/** Removes each path (a link itself, never what it leads to). */
export async function removeAll(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
}

/**
 * Writes `text` as the file `name` in `dir` (the stack's .supatype, say), through the same checks as
 * every deploy write: a link there is refused rather than followed.
 */
export async function writeFileIn(dir: string, name: string, text: string): Promise<void> {
  await writeChanged([fileUnder(writeRoot(dir, dir, { mayBeLink: true }), name, text)])
}

/** What was at each path before a write: its text, or null when nothing was there. */
export type FileSnapshot = ReadonlyArray<{ path: string; was: string | null }>

/** The text at each of `paths` now, so a write that fails part-way can be undone ({@link restoreFiles}). */
export async function snapshotFiles(paths: readonly string[]): Promise<FileSnapshot> {
  return Promise.all(paths.map(async (path) => ({ path, was: await textBefore(path) })))
}

/**
 * The text at `path`, or null when nothing is there (ENOENT) and nothing else. Any other failure to
 * read rejects: noting it as absent would have a rollback delete a file that was there.
 */
async function textBefore(path: string): Promise<string | null> {
  try {
    return await (fileReader?.(path) ?? readFile(path, "utf8"))
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return null
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)}), so it was not written over`)
  }
}

/**
 * Puts every path of `snapshot` back as it was under `root`: a file that was there is written again,
 * with the same checks as every deploy write, and one that was not is removed. Rejects when any could
 * not be put back.
 */
export async function restoreFiles(snapshot: FileSnapshot, root: WriteRoot): Promise<void> {
  await Promise.all(
    snapshot.map(({ path, was }) =>
      was === null ? rm(path, { force: true }) : writeOne({ path, source: was, root: root.path, rootReal: root.real }),
    ),
  )
}

/** A stand-in for reading a file's text before a hook is written: a promise to use, or undefined to read it. */
type FileReader = (path: string) => Promise<string | null> | undefined

let fileReader: FileReader | null = null

/** @internal Tests: fail a read, as a file the control plane may not read would, without one. */
export function setFileReaderForTests(reader: FileReader | null): void {
  fileReader = reader
}
