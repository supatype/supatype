/**
 * Engine management commands:
 *   supatype engine version      — show pinned, cached, and latest versions
 *   supatype engine update-check — check for newer engine versions
 *   supatype engine prune        — remove old cached engine versions
 */

import type { Command } from "commander"
import { ENGINE_VERSION } from "../engine-version.js"
import { detectPlatform } from "../engine/platform.js"
import {
  hasCachedBinary,
  listCachedVersions,
  pruneCacheExcept,
  saveUpdateCheck,
} from "../engine/cache.js"
import { checkLatestVersion } from "../engine/resolve.js"

export function registerEngine(program: Command): void {
  const engine = program
    .command("engine")
    .description("Manage the Supatype engine binary")

  // supatype engine version
  engine
    .command("version")
    .description("Show engine version information")
    .action(async () => {
      const platform = detectPlatform()
      const cached = hasCachedBinary(ENGINE_VERSION, platform)
      const cachedVersions = listCachedVersions()

      console.log(`Engine: v${ENGINE_VERSION} (pinned)`)
      console.log(
        `Cache:  ${cached ? `v${ENGINE_VERSION} ✓` : "not downloaded"}`,
      )

      if (cachedVersions.length > 1) {
        const others = cachedVersions.filter((v) => v !== ENGINE_VERSION)
        console.log(`Other cached versions: ${others.join(", ")}`)
      }

      // Check latest
      try {
        const latest = await checkLatestVersion()
        if (latest) {
          await saveUpdateCheck(latest.version)
          if (latest.version !== ENGINE_VERSION) {
            console.log(
              `Latest: v${latest.version} — update available, run: npm update @supatype/cli`,
            )
          } else {
            console.log(`Latest: v${latest.version} (up to date)`)
          }
        }
      } catch {
        console.log("Latest: unable to check (offline?)")
      }
    })

  // supatype engine update-check
  engine
    .command("update-check")
    .description("Check if a newer engine version is available")
    .action(async () => {
      const latest = await checkLatestVersion()

      if (!latest) {
        console.error(
          "Could not check for updates. Check your internet connection.",
        )
        process.exitCode = 1
        return
      }

      await saveUpdateCheck(latest.version)

      if (latest.version !== ENGINE_VERSION) {
        console.log(
          `Supatype engine v${latest.version} is available (current: v${ENGINE_VERSION}).`,
        )
        console.log(`Run: npm update @supatype/cli`)
      } else {
        console.log(`Engine v${ENGINE_VERSION} is up to date.`)
      }
    })

  // supatype engine prune
  engine
    .command("prune")
    .description("Remove all cached engine versions except the current one")
    .action(() => {
      const { removed, bytesFreed } = pruneCacheExcept(ENGINE_VERSION)

      if (removed.length === 0) {
        console.log("Nothing to prune — only the current version is cached.")
        return
      }

      const mb = (bytesFreed / (1024 * 1024)).toFixed(1)
      console.log(`Removed ${removed.length} cached version(s): ${removed.join(", ")}`)
      console.log(`Space reclaimed: ${mb}MB`)
    })

  // supatype engine versions (list all released versions)
  engine
    .command("versions")
    .description("List all released engine versions")
    .action(async () => {
      const { fetchJson } = await import("../engine/download.js")
      const { CDN_BASE_URL } = await import("../engine-version.js")

      interface VersionEntry {
        version: string
        date: string
      }

      const versions = await fetchJson<VersionEntry[]>(
        `${CDN_BASE_URL}/versions.json`,
      )

      if (!versions || versions.length === 0) {
        console.log("No released versions found.")
        return
      }

      console.log("Released engine versions:")
      for (const v of versions) {
        const current = v.version === ENGINE_VERSION ? " (current)" : ""
        console.log(`  v${v.version}  ${v.date}${current}`)
      }
    })
}
