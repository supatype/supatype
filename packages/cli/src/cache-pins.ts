/**
 * Pin-aware cache eviction — collect `versions.*` pins across local projects (C13).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { BINARY_COMPONENTS, type Component } from "./components.js"
import { cachePath, cacheRoot, pinnedVersion, VERSION_PIN_LOCAL } from "./binary-cache.js"
import { loadConfig } from "./config.js"
import type { SupatypeProjectConfig } from "./project-config.js"

const CONFIG_FILENAMES = ["supatype.config.ts", "supatype.config.js", "supatype.config.mjs"] as const

export interface PinSource {
  component: Component
  version: string
  projectDir: string
  projectName: string
}

export interface CleanCacheEntry {
  component: Component
  version: string
  bytes: number
}

export interface CleanCacheResult {
  removed: CleanCacheEntry[]
  skipped: Array<CleanCacheEntry & { reason: string }>
  warned: string[]
}

/** Union pinned semver versions from one or more loaded configs. */
export function pinnedVersionsFromConfigs(
  entries: Array<{ projectDir: string; config: SupatypeProjectConfig }>,
): { protectedVersions: Map<Component, Set<string>>; sources: PinSource[] } {
  const protectedVersions = new Map<Component, Set<string>>()
  const sources: PinSource[] = []

  for (const { projectDir, config } of entries) {
    const projectName = config.project?.name?.trim() || projectDir
    for (const component of BINARY_COMPONENTS) {
      const version = pinnedVersion(component, config)
      if (!version || version === VERSION_PIN_LOCAL) continue
      let set = protectedVersions.get(component)
      if (!set) {
        set = new Set<string>()
        protectedVersions.set(component, set)
      }
      set.add(version)
      sources.push({ component, version, projectDir, projectName })
    }
  }

  return { protectedVersions, sources }
}

function hasSupatypeConfig(dir: string): boolean {
  return CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)))
}

/** Walk `root` up to `maxDepth` looking for directories that contain a Supatype config file. */
export function findSupatypeProjectDirs(root: string, maxDepth = 4): string[] {
  const absRoot = resolve(root)
  if (!existsSync(absRoot)) return []

  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: absRoot, depth: 0 }]

  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    const { dir, depth } = item

    if (hasSupatypeConfig(dir)) {
      found.push(dir)
      continue
    }

    if (depth >= maxDepth) continue

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".supatype") continue
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
    }
  }

  return found
}

/** Resolve project directories whose `versions` pins should protect cache entries. */
export function resolveCacheProjectDirs(cwd: string, extraProjects: string[]): string[] {
  const dirs = new Set<string>()

  for (const raw of extraProjects) {
    const abs = resolve(raw)
    if (hasSupatypeConfig(abs)) dirs.add(abs)
  }

  if (hasSupatypeConfig(cwd)) dirs.add(resolve(cwd))

  const envRoots = process.env.SUPATYPE_CACHE_PROJECT_ROOTS?.trim()
  if (envRoots) {
    for (const segment of envRoots.split(",")) {
      const root = segment.trim()
      if (!root) continue
      for (const dir of findSupatypeProjectDirs(root)) {
        dirs.add(dir)
      }
    }
  }

  return [...dirs]
}

export function loadPinnedVersionsForProjects(
  projectDirs: string[],
): { protectedVersions: Map<Component, Set<string>>; sources: PinSource[]; loadWarnings: string[] } {
  const configs: Array<{ projectDir: string; config: SupatypeProjectConfig }> = []
  const loadWarnings: string[] = []

  for (const projectDir of projectDirs) {
    try {
      configs.push({ projectDir, config: loadConfig(projectDir) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loadWarnings.push(`${projectDir}: ${message}`)
    }
  }

  const { protectedVersions, sources } = pinnedVersionsFromConfigs(configs)
  return { protectedVersions, sources, loadWarnings }
}

export function listCachedVersions(component: Component): string[] {
  const compDir = join(cacheRoot(), component)
  if (!existsSync(compDir)) return []
  return readdirSync(compDir).filter((name) => {
    try {
      return statSync(join(compDir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

function pinReason(
  component: Component,
  version: string,
  sources: PinSource[],
): string | undefined {
  const matches = sources.filter((s) => s.component === component && s.version === version)
  if (matches.length === 0) return undefined
  const names = [...new Set(matches.map((m) => m.projectName))]
  return `pinned by ${names.join(", ")}`
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        total += dirSize(full)
      } else {
        total += statSync(full).size
      }
    }
  } catch {
    // skip unreadable
  }
  return total
}

export interface CleanCachedBinariesOptions {
  components: Component[]
  version?: string
  force?: boolean
  dryRun?: boolean
  projectDirs: string[]
}

export function cleanCachedBinaries(options: CleanCachedBinariesOptions): CleanCacheResult {
  const { protectedVersions, sources, loadWarnings } = loadPinnedVersionsForProjects(options.projectDirs)
  const result: CleanCacheResult = { removed: [], skipped: [], warned: [...loadWarnings] }

  const force = options.force === true
  const dryRun = options.dryRun === true
  const explicitVersion = options.version?.trim()

  for (const component of options.components) {
    const versions = explicitVersion ? [explicitVersion] : listCachedVersions(component)

    for (const version of versions) {
      const vDir = cachePath(component, version)
      if (!existsSync(vDir)) {
        if (explicitVersion) continue
        continue
      }

      const bytes = dirSize(vDir)
      const entry: CleanCacheEntry = { component, version, bytes }
      const pinned = protectedVersions.get(component)?.has(version) ?? false

      if (!force && !explicitVersion && pinned) {
        const reason = pinReason(component, version, sources) ?? "pinned"
        result.skipped.push({ ...entry, reason })
        continue
      }

      if (!force && explicitVersion && pinned) {
        const reason = pinReason(component, version, sources) ?? "pinned"
        result.warned.push(
          `${component}@${version} is ${reason} — removing anyway (explicit version)`,
        )
      }

      if (!dryRun) {
        rmSync(vDir, { recursive: true, force: true })
      }
      result.removed.push(entry)
    }
  }

  return result
}

export function isVersionPinned(
  component: Component,
  version: string,
  projectDirs: string[],
): boolean {
  const { protectedVersions } = loadPinnedVersionsForProjects(projectDirs)
  return protectedVersions.get(component)?.has(version) ?? false
}
