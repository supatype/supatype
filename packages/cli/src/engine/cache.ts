/**
 * Local cache management for engine binaries.
 * Binaries are stored at ~/.supatype/engine/{version}/supatype-engine[.exe]
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { PlatformInfo } from "./platform.js"

/**
 * Root cache directory: ~/.supatype/engine/
 */
export function getCacheDir(): string {
  return join(homedir(), ".supatype", "engine")
}

/**
 * Full path to a cached engine binary for a specific version.
 */
export function getCachedBinaryPath(version: string, platform: PlatformInfo): string {
  return join(getCacheDir(), version, platform.binaryName)
}

/**
 * Check if a valid cached binary exists for the given version.
 */
export function hasCachedBinary(version: string, platform: PlatformInfo): boolean {
  const path = getCachedBinaryPath(version, platform)
  return existsSync(path)
}

/**
 * Ensure the cache directory for a version exists.
 */
export function ensureCacheDir(version: string): string {
  const dir = join(getCacheDir(), version)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * List all cached engine versions.
 */
export function listCachedVersions(): string[] {
  const cacheDir = getCacheDir()
  if (!existsSync(cacheDir)) return []

  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

/**
 * Remove all cached versions except the specified one.
 * Returns the total bytes freed.
 */
export function pruneCacheExcept(keepVersion: string): { removed: string[]; bytesFreed: number } {
  const versions = listCachedVersions()
  const removed: string[] = []
  let bytesFreed = 0

  for (const version of versions) {
    if (version === keepVersion) continue
    const versionDir = join(getCacheDir(), version)
    bytesFreed += getDirSize(versionDir)
    rmSync(versionDir, { recursive: true, force: true })
    removed.push(version)
  }

  return { removed, bytesFreed }
}

function getDirSize(dir: string): number {
  let size = 0
  if (!existsSync(dir)) return size

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile()) {
      size += statSync(path).size
    } else if (entry.isDirectory()) {
      size += getDirSize(path)
    }
  }
  return size
}

/**
 * Update check throttling.
 * Stores last check timestamp in ~/.supatype/update-check.json
 */
const UPDATE_CHECK_FILE = join(homedir(), ".supatype", "update-check.json")
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface UpdateCheckData {
  lastCheck: number
  latestVersion?: string
}

export async function shouldCheckForUpdates(): Promise<boolean> {
  // Skip in CI environments
  if (process.env.CI === "true" || process.env.CI === "1") return false

  try {
    if (!existsSync(UPDATE_CHECK_FILE)) return true
    const data: UpdateCheckData = JSON.parse(await readFile(UPDATE_CHECK_FILE, "utf8"))
    return Date.now() - data.lastCheck > CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

export async function saveUpdateCheck(latestVersion: string): Promise<void> {
  const dir = join(homedir(), ".supatype")
  mkdirSync(dir, { recursive: true })

  const data: UpdateCheckData = {
    lastCheck: Date.now(),
    latestVersion,
  }
  await writeFile(UPDATE_CHECK_FILE, JSON.stringify(data, null, 2))
}

export async function getLastKnownLatestVersion(): Promise<string | undefined> {
  try {
    if (!existsSync(UPDATE_CHECK_FILE)) return undefined
    const data: UpdateCheckData = JSON.parse(await readFile(UPDATE_CHECK_FILE, "utf8"))
    return data.latestVersion
  } catch {
    return undefined
  }
}
