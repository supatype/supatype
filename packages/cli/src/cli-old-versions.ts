/**
 * CLI programs the npm starter downloaded for versions other than the one running.
 *
 * Each version of the npm package downloads its own program, and upgrading leaves the previous one
 * in the cache, so they add up. Nothing deletes them by itself: a project still on an older version
 * would download it again. The starter says when they pass a size once a day, and
 * `supatype cache clean` removes them.
 *
 * The starter loads this before every command, so it imports nothing but Node's own modules and
 * the cache path.
 */

import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { dirSize, formatBytes } from "./byte-size.js"
import { cliCacheRoot } from "./cli-program-path.js"

/** Old versions past this size get a notice. About two on Windows, where a program is 141 MB. */
export const OLD_VERSIONS_NOTICE_BYTES = 250 * 1024 * 1024

const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** When the starter last added up the old versions, kept as this file's modification time. */
const CHECKED_MARKER = ".old-versions-checked"

export interface CachedCliVersion {
  version: string
  dir: string
  bytes: number
}

/** The version directories under `root`, or none when nothing has been cached yet. */
function versionDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Every cached CLI version except `running`, with its size on disk. */
export function oldCliVersions(running: string, home?: string): CachedCliVersion[] {
  const root = cliCacheRoot(home)
  return versionDirs(root)
    .filter((name) => name !== running)
    .map((name) => ({ version: name, dir: join(root, name), bytes: dirSize(join(root, name)) }))
}

function checkedWithin(marker: string, now: number): boolean {
  try {
    return now - statSync(marker).mtimeMs < NOTICE_INTERVAL_MS
  } catch {
    return false
  }
}

/**
 * The line the starter prints when old versions are past the size, at most once a day. Undefined
 * when there is nothing to say, or it was checked in the last day.
 */
export function oldVersionsNotice(running: string, now: number = Date.now(), home?: string): string | undefined {
  const marker = join(cliCacheRoot(home), CHECKED_MARKER)
  if (checkedWithin(marker, now)) return undefined
  const bytes = oldCliVersions(running, home).reduce((total, version) => total + version.bytes, 0)
  writeFileSync(marker, "")
  if (bytes <= OLD_VERSIONS_NOTICE_BYTES) return undefined
  return `[supatype] Old CLI versions are using ${formatBytes(bytes)}. Run \`supatype cache clean\` to remove them.`
}

export interface CleanOldCliVersionsOptions {
  /** Only list what would go. */
  dryRun: boolean
  /** Only this version, as `cache clean engine 0.4.2` removes one engine version. */
  version?: string
  home?: string
}

/**
 * Removes every cached CLI version except `running`, or the one `version` names. The program this
 * process runs from is kept whatever its version says: a source build reports 0.0.0, and on Windows
 * a running executable cannot be deleted anyway.
 */
export function cleanOldCliVersions(running: string, opts: CleanOldCliVersionsOptions): CleanedCliVersions {
  const runningDir = resolve(dirname(process.execPath))
  const old = oldCliVersions(running, opts.home)
    .filter((v) => opts.version === undefined || v.version === opts.version)
    .filter((v) => resolve(v.dir) !== runningDir)
  if (opts.dryRun) return { removed: old, inUse: [] }
  const inUse = old.filter((version) => !removed(version.dir))
  return { removed: old.filter((version) => !inUse.includes(version)), inUse }
}

export interface CleanedCliVersions {
  removed: CachedCliVersion[]
  /** Versions whose program another project is running: Windows will not delete it. */
  inUse: CachedCliVersion[]
}

function removed(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
