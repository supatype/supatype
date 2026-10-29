/**
 * How native dev starts the storage service: `overrides.storage`, else the release archive from the
 * CDN (unpacked beside where it is cached), else Node on the monorepo's packages/storage build.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { extractArchive } from "./archive-extract.js"
import { launchFromOverride, monorepoLaunch, type ComponentLaunchSpec } from "./component-launch.js"
import { ensureBinary } from "./ensure-binary.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** The executable a storage release archive holds. */
export function storageExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "supatype-storage.exe" : "supatype-storage"
}

/**
 * Where `archivePath` is unpacked: a directory named for the archive beside it, so each version
 * and platform has its own. Unpacked once; a directory holding the executable is reused.
 */
export function unpackedStorage(archivePath: string): string {
  const dir = archivePath.replace(/\.(zip|tar\.gz)$/, "")
  const exe = join(dir, storageExecutableName())
  if (!existsSync(exe)) extractArchive(archivePath, dir)
  if (!existsSync(exe)) throw new Error(`${archivePath} holds no ${storageExecutableName()}`)
  return exe
}

export async function resolveStorageLaunch(config: SupatypeProjectConfig, cwd: string): Promise<ComponentLaunchSpec> {
  const override = config.overrides?.storage?.trim()
  if (override) return launchFromOverride("storage", override, cwd)
  try {
    return { bin: unpackedStorage(await ensureBinary("storage", config)), args: [] }
  } catch (err) {
    const fallback = monorepoLaunch("storage")
    if (fallback) return fallback
    throw err
  }
}
