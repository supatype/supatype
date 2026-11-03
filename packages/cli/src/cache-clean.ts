/**
 * Helpers for `supatype cache list` / `cache clean` (shared sizing + formatting).
 */

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { BINARY_COMPONENTS, type Component } from "./components.js"
import { cacheRoot } from "./binary-cache.js"
import { dirSize } from "./byte-size.js"
import { isVersionPinned, loadPinnedVersionsForProjects, resolveCacheProjectDirs } from "./cache-pins.js"


export function listCacheEntries(projectDirs: string[]): Array<{
  component: Component
  version: string
  bytes: number
  pinned: boolean
}> {
  const root = cacheRoot()
  const { protectedVersions } = loadPinnedVersionsForProjects(projectDirs)
  const entries: Array<{ component: Component; version: string; bytes: number; pinned: boolean }> = []

  for (const component of BINARY_COMPONENTS) {
    const compDir = join(root, component)
    if (!statExists(compDir)) continue

    for (const version of readdirSync(compDir)) {
      const vDir = join(compDir, version)
      if (!statIsDir(vDir)) continue
      entries.push({
        component,
        version,
        bytes: dirSize(vDir),
        pinned: protectedVersions.get(component)?.has(version) ?? false,
      })
    }
  }

  return entries
}

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export { BINARY_COMPONENTS, resolveCacheProjectDirs }
