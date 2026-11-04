/**
 * Where the CLI's compiled program lives on disk, and which machines it is published for.
 *
 * Read by the npm package's starter before every command, so it imports nothing but Node's own
 * modules and the cache root: everything else the starter would load costs every command its time.
 */

import { join } from "node:path"
import type { PlatformId } from "./binary-cache.js"
import { cacheRoot } from "./cache-root.js"

/** The targets the release workflow compiles, as `process.platform` and `process.arch` name them. */
const PUBLISHED_TARGETS: Readonly<Record<string, PlatformId>> = {
  "linux-x64": { os: "linux", arch: "amd64" },
  "linux-arm64": { os: "linux", arch: "arm64" },
  "darwin-x64": { os: "darwin", arch: "amd64" },
  "darwin-arm64": { os: "darwin", arch: "arm64" },
  "win32-x64": { os: "windows", arch: "amd64" },
}

/**
 * The published target for this machine, or an error naming the ones that exist. currentPlatform()
 * reads any OS that is not macOS or Windows as Linux, so FreeBSD would otherwise download a Linux
 * build and fail to start it with an error that names neither.
 */
export function publishedTarget(platform: string = process.platform, arch: string = process.arch): PlatformId {
  const target = PUBLISHED_TARGETS[`${platform}-${arch}`]
  if (target !== undefined) return target
  throw new Error(
    `The Supatype CLI is not built for ${platform}-${arch}. ` +
      `It is published for ${Object.keys(PUBLISHED_TARGETS).join(", ")}.`,
  )
}

/** The executable inside a release archive, and in the cache. */
export function cliExecutableName(platform: PlatformId): string {
  return platform.os === "windows" ? "supatype.exe" : "supatype"
}

/** The directory holding one subdirectory per cached CLI version. */
export function cliCacheRoot(home?: string): string {
  return join(cacheRoot(home), "cli")
}

/** Where a downloaded release is unpacked, so a repeated run does not refetch it. */
export function cliCachePath(version: string, platform: PlatformId, home?: string): string {
  return join(cliCacheRoot(home), version, cliExecutableName(platform))
}
