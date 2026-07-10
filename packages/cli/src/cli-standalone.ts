/**
 * Standalone CLI binary CDN download (self-update + curl|sh installers).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { currentPlatform, type PlatformId } from "./binary-cache.js"

const CDN_BASE = "https://releases.supatype.com"

export function cliCdnPath(version: string, platform: PlatformId): string {
  const win = platform.os === "windows"
  return `/cli/v${version}/supatype-cli-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
}

export function cliCachePath(version: string, platform: PlatformId = currentPlatform()): string {
  const win = platform.os === "windows"
  const name = `supatype-cli-${platform.os}-${platform.arch}${win ? ".exe" : ""}`
  return join(homedir(), ".supatype", "cache", "cli", version, name)
}

export async function fetchStandaloneCliLatestVersion(): Promise<string> {
  const resp = await fetch(`${CDN_BASE}/cli/latest.json`)
  if (!resp.ok) {
    throw new Error(`Failed to fetch CLI latest.json: HTTP ${resp.status}`)
  }
  const data = await resp.json() as { version?: unknown }
  if (typeof data.version !== "string" || data.version.trim() === "") {
    throw new Error("Invalid cli/latest.json: missing version")
  }
  return data.version.trim()
}

/** Download the standalone CLI binary for the current platform. */
export async function downloadStandaloneCli(version?: string): Promise<string> {
  const platform = currentPlatform()
  const resolved = version ?? await fetchStandaloneCliLatestVersion()
  const dest = cliCachePath(resolved, platform)
  if (existsSync(dest)) return dest

  const url = `${CDN_BASE}${cliCdnPath(resolved, platform)}`
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to download CLI from ${url}: HTTP ${resp.status}`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 64) {
    throw new Error("Downloaded CLI artifact is too small")
  }
  const head = buf.subarray(0, 5).toString("utf8").toLowerCase()
  if (head.startsWith("<!doc") || head.startsWith("{")) {
    throw new Error("Downloaded CLI artifact looks like an error page, not a binary")
  }

  mkdirSync(join(dest, ".."), { recursive: true })
  writeFileSync(dest, buf)
  if (platform.os !== "windows") {
    chmodSync(dest, 0o755)
  }
  return dest
}
